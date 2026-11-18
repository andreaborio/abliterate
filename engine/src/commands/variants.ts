import { ENDPOINTS, makeHttp } from "../deps/net";
import { computeScope, trackedFiles } from "../git";
import { langOf, skipPath, stripComments } from "../lang";
import { readWorktreeText } from "../worktree";
import { RULES } from "../rules";
import { scan, type Candidate } from "../scan";
import { allowFlags, EXIT, git, print, str, UsageError, type Flags } from "../util";
import { SECURITY_COMMIT, seedsFromPatch, type Seed } from "../variants";

export const VARIANTS_HELP = `abliterate variants (--from SHA|URL|ADVISORY-ID | --history) [--base REF] [--max-commits N]
  Learns from a known fix (a local commit, a GitHub commit URL, or an OSV/GHSA/CVE id whose fix commit is
  public) which rule the vulnerable code broke and which guard the fix added, then finds the same pattern
  without that guard in this repository. --history uses this repository's own past security fixes.
  Advisory lookups send only the advisory id; no source leaves the machine.`;

/** Scanning the last 500 commits covers years of history in most repos and stays under a few seconds. */
const DEFAULT_MAX_COMMITS = 500;

const GITHUB_COMMIT = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/;

async function seedsFrom(from: string, root: string, offline: boolean, notes: string[]): Promise<Seed[]> {
  if (/^[0-9a-f]{7,40}$/i.test(from)) {
    const patch = git(root, ["show", "--no-ext-diff", "--no-textconv", "--unified=0", "--format=%s", from], { allowFail: true });
    if (!patch) throw new UsageError(`commit ${from} not found in this clone`);
    return seedsFromPatch(from, patch.split("\n")[0]!, patch);
  }
  const http = makeHttp(offline);
  const patchFrom = async (url: string, title: string) => {
    const m = GITHUB_COMMIT.exec(url);
    if (!m) return [];
    const patch = (await http.get(ENDPOINTS.githubPatch(m[1]!, m[2]!, m[3]!), { text: true, maxAgeMs: 30 * 24 * 3600_000 })) as string | undefined;
    if (!patch) { notes.push(`Could not fetch ${url}${offline ? " (offline)" : ""}`); return []; }
    return seedsFromPatch(url, title, patch);
  };
  if (GITHUB_COMMIT.test(from)) return patchFrom(from, from);
  if (/^(GHSA-|CVE-|PYSEC-|GO-|RUSTSEC-|OSV-)/i.test(from)) {
    const v = (await http.get(ENDPOINTS.osvVuln(from))) as { id: string; summary?: string; references?: { type: string; url: string }[]; database_specific?: { cwe_ids?: string[] } } | undefined;
    if (!v) { notes.push(`Advisory ${from} not found${offline ? " in the cache (offline)" : ""}`); return []; }
    const fixes = (v.references ?? []).map((r) => r.url).filter((u) => GITHUB_COMMIT.test(u));
    const seeds = (await Promise.all(fixes.slice(0, 5).map((u) => patchFrom(u, `${v.id}: ${v.summary ?? ""}`)))).flat();
    // When the fix is in a library, its internals rarely recur in app code: fall back to the advisory's CWE class.
    for (const cwe of v.database_specific?.cwe_ids ?? []) {
      for (const r of RULES.filter((x) => x.cwe === cwe)) {
        if (!seeds.some((s) => s.rule === r.id)) seeds.push({ origin: v.id, title: `${v.id}: ${v.summary ?? ""} (class ${cwe})`, file: "", rule: r.id, cwe, guards: [], anchors: [], removed: "" });
      }
    }
    if (!fixes.length) notes.push(`${v.id} lists no public fix commit; searched by its CWE class only.`);
    return seeds;
  }
  throw new UsageError("--from takes a commit sha, a GitHub commit URL, or an advisory id (GHSA-, CVE-, PYSEC-, GO-, RUSTSEC-)");
}

function shapeMatches(root: string, files: string[], seed: Seed): Candidate[] {
  const out: Candidate[] = [];
  const needAll = seed.anchors.map((a) => new RegExp(`\\b${a.replace(/\$/g, "\\$")}\\s*\\(`));
  const guardRe = seed.guards.length ? new RegExp(`\\b(${seed.guards.map((g) => g.replace(/\$/g, "\\$")).join("|")})\\s*\\(`) : undefined;
  for (const path of files) {
    if (skipPath(path) || langOf(path) !== langOf(seed.file)) continue;
    const text = readWorktreeText(root, path);
    if (text === undefined) continue;
    const code = stripComments(text, langOf(path)).split(/\r?\n/);
    code.forEach((l, i) => {
      if (needAll.every((re) => re.test(l)) && !(guardRe && guardRe.test(l))) {
        out.push({ rule: `shape:${seed.anchors.join("+")}`, cwe: seed.cwe ?? "CWE-20", title: `Same call shape as the code fixed in ${seed.origin.slice(0, 12)}`, confidence: "low", path, line: i + 1, changedIn: null, snippet: text.split(/\r?\n/)[i]!.trim().slice(0, 200) });
      }
    });
  }
  return out;
}

export async function variants(flags: Flags, cwd: string): Promise<number> {
  allowFlags(flags, ["from", "history", "base", "max-commits", "offline"]);
  const from = str(flags, "from");
  if (!from && flags.history !== true) throw new UsageError("variants needs --from or --history");
  const sc = computeScope(cwd, str(flags, "base"));
  const notes = [...sc.notes];
  const seeds: Seed[] = [];

  if (from) seeds.push(...(await seedsFrom(from, sc.root, flags.offline === true, notes)));
  if (flags.history === true) {
    const max = Number(str(flags, "max-commits") ?? DEFAULT_MAX_COMMITS);
    if (!Number.isInteger(max) || max < 1) throw new UsageError("--max-commits must be a positive integer");
    const log = git(sc.root, ["log", "--no-merges", `--max-count=${max}`, "--format=%H%x09%s", "HEAD"], { allowFail: true });
    const fixes = log.split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]).filter(([, s]) => SECURITY_COMMIT.test(s ?? ""));
    for (const [sha, subject] of fixes) {
      const patch = git(sc.root, ["show", "--no-ext-diff", "--no-textconv", "--unified=0", "--format=%s", sha], { allowFail: true });
      seeds.push(...seedsFromPatch(sha, subject, patch));
    }
    notes.push(`${fixes.length} security-fix commit(s) found in the last ${max} commits.`);
  }

  // Rule seeds: run that rule over the tree; drop hits where the seed's guard is already applied.
  const variantsOut: (Candidate & { seed: string })[] = [];
  const byRule = new Map<string, Seed[]>();
  for (const s of seeds) if (s.rule) byRule.set(s.rule, [...(byRule.get(s.rule) ?? []), s]);
  if (byRule.size) {
    const rules = RULES.filter((r) => byRule.has(r.id));
    const res = scan(cwd, { base: sc.base, rules });
    for (const c of res.candidates) {
      const relevant = byRule.get(c.rule)!;
      const guarded = relevant.some((s) => s.guards.length && new RegExp(`\\b(${s.guards.join("|")})\\s*\\(`).test(c.snippet));
      if (!guarded) variantsOut.push({ ...c, seed: relevant.map((s) => `${s.origin.slice(0, 12)} ${s.title}`).join(" | ") });
    }
  }
  const files = [...new Set([...trackedFiles(sc.root), ...sc.untracked])];
  for (const s of seeds.filter((x) => !x.rule)) for (const c of shapeMatches(sc.root, files, s)) variantsOut.push({ ...c, seed: `${s.origin.slice(0, 12)} ${s.title}` });

  print({
    seeds: seeds.map(({ origin, title, file, rule, cwe, guards, removed }) => ({ origin, title, file, rule: rule ?? null, cwe: cwe ?? null, guards, removed })),
    variants: variantsOut,
    notes,
    guidance: "Each variant repeats a pattern a past fix removed. Confirm it reaches attacker-controlled data, check whether the same guard is applied elsewhere on its path, and report it as introduced or pre-existing by changedIn.",
  });
  return EXIT.ok;
}
