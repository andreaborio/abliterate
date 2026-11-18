import { computeScope, trackedFiles } from "../git";
import { readWorktreeText } from "../worktree";
import { RULES } from "../rules";
import { scan, type Candidate } from "../scan";
import { entryPoints, type EntryPoint } from "../surface";
import { allowFlags, EXIT, print, str, UsageError, type Flags } from "../util";

export const SCOPE_HELP = `abliterate scope [--base REF]
  Verified review states: commits since the merge-base (push), staged (index), unstaged (worktree), untracked.
  Never fetches or changes branches; diff drivers and textconv are disabled.`;

export const SINKS_HELP = `abliterate sinks [--base REF [--head REF]] [--changed] [--include-guarded] [--rule ID,...] [--format json|md]
  With --head only the named commit is reviewed; local files and the index are excluded.
  Candidate vulnerable code by CWE, each marked with the snapshot that changed it (push, index, worktree,
  untracked) or null when it predates the change. Candidates must be traced and confirmed; they are not findings.`;

export const SURFACE_HELP = `abliterate surface [--base REF] [--changed] [--format json|md]
  Entry points (HTTP routes, server actions, jobs, webhooks, CI triggers) and the auth names on each declaration.`;

export function scope(flags: Flags, cwd: string): number {
  allowFlags(flags, ["base"]);
  print(computeScope(cwd, str(flags, "base")));
  return EXIT.ok;
}

const fmt = (flags: Flags) => {
  const f = str(flags, "format") ?? "json";
  if (f !== "json" && f !== "md") throw new UsageError("--format must be json or md");
  return f;
};

export function candidatesMd(cs: Candidate[], guarded: Candidate[]): string {
  const row = (c: Candidate) => `| ${c.changedIn ?? "before"} | ${c.cwe} | \`${c.path}:${c.line}\` | ${c.rule} | ${c.confidence} | \`${c.snippet.replace(/\|/g, "\\|").replace(/`/g, "'")}\` |`;
  const out = ["| changed in | CWE | location | rule | confidence | code |", "| --- | --- | --- | --- | --- | --- |", ...cs.map(row)];
  if (guarded.length) out.push("", `${guarded.length} more candidate(s) had a recognised guard in the same block; rerun with --include-guarded to list them.`);
  return out.join("\n") + "\n";
}

export function sinks(flags: Flags, cwd: string): number {
  allowFlags(flags, ["base", "head", "changed", "include-guarded", "rule", "format"]);
  const format = fmt(flags);
  const ids = str(flags, "rule")?.split(",").map((s) => s.trim()).filter(Boolean);
  const rules = ids ? RULES.filter((r) => ids.includes(r.id)) : RULES;
  if (ids && rules.length !== ids.length) throw new UsageError(`unknown rule id in --rule; known: ${RULES.map((r) => r.id).join(", ")}`);
  const r = scan(cwd, { base: str(flags, "base"), head: str(flags, "head"), changedOnly: flags.changed === true, rules });
  const includeGuarded = flags["include-guarded"] === true;
  if (format === "md") { process.stdout.write(candidatesMd(includeGuarded ? [...r.candidates, ...r.guarded] : r.candidates, includeGuarded ? [] : r.guarded)); return EXIT.ok; }
  print({
    base: r.scope.base ?? null, mergeBase: r.scope.mergeBase ?? null, head: r.scope.head ?? null, notes: r.scope.notes,
    filesScanned: r.files,
    candidates: r.candidates,
    ...(includeGuarded ? { guarded: r.guarded } : { guardedCount: r.guarded.length }),
    reminder: "Candidates are leads. Trace each from source to sink, look for the guard on that path, and try to disprove it before reporting.",
  });
  return EXIT.ok;
}

export function surface(flags: Flags, cwd: string): number {
  allowFlags(flags, ["base", "changed", "format"]);
  const format = fmt(flags);
  const sc = computeScope(cwd, str(flags, "base"));
  const changed = new Map<string, [number, number][]>();
  for (const s of ["push", "index", "worktree"] as const) for (const f of sc.states[s]) changed.set(f.path, [...(changed.get(f.path) ?? []), ...f.hunks]);
  for (const u of sc.untracked) changed.set(u, [[1, Number.MAX_SAFE_INTEGER]]);
  const files = flags.changed === true ? [...changed.keys()] : [...new Set([...trackedFiles(sc.root), ...sc.untracked])];
  const eps: (EntryPoint & { changed: boolean })[] = [];
  for (const path of files.sort()) {
    const text = readWorktreeText(sc.root, path);
    if (text === undefined) continue;
    for (const e of entryPoints(path, text)) {
      const hunks = changed.get(path);
      eps.push({ ...e, changed: !!hunks?.some(([s, n]) => e.line >= s && e.line < s + n) });
    }
  }
  if (format === "md") {
    process.stdout.write(["| changed | kind | method | route | location | guards on declaration |", "| --- | --- | --- | --- | --- | --- |",
      ...eps.map((e) => `| ${e.changed ? "yes" : ""} | ${e.kind} | ${e.method ?? ""} | ${e.route ?? ""} | \`${e.path}:${e.line}\` | ${e.guards.join(", ") || "none seen"} |`)].join("\n") + "\n");
    return EXIT.ok;
  }
  print({ entryPoints: eps, note: "Guards listed are names on the declaration only; global middleware and policies elsewhere must be checked in the code." });
  return EXIT.ok;
}
