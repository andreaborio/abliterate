import { langOf, stripComments } from "./lang";
import { RULES, type Ctx, type Rule } from "./rules";

// A seed is what a past fix teaches: the rule the removed code broke and the guard the fix added.

export interface Seed {
  origin: string; // commit sha, URL or advisory id
  title: string;
  file: string;
  rule?: string;
  cwe?: string;
  /** Call names the fix introduced around the vulnerable expression, e.g. escape, quote, safe_join. */
  guards: string[];
  /** Call names present in the vulnerable line, used for shape matching when no rule applies. */
  anchors: string[];
  removed: string;
}

interface PatchFile { path: string; removed: string[]; added: string[] }

export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { path: "", removed: [], added: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith("+++ ")) { cur.path = line.slice(4).replace(/^b\//, ""); continue; }
    if (line.startsWith("--- ")) { if (!cur.path) cur.path = line.slice(4).replace(/^a\//, ""); continue; }
    if (line.startsWith("-") && !line.startsWith("---")) cur.removed.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++")) cur.added.push(line.slice(1));
  }
  return files.filter((f) => f.path && f.path !== "/dev/null" && f.removed.length);
}

// Language keywords and module loaders are never guards.
const calls = (s: string) => new Set([...s.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!).filter((n) => !/^(if|for|while|switch|return|function|catch|typeof|await|new|require|import|include|include_once|require_once|use|def|print|len|str)$/.test(n)));

function lineHits(path: string, line: string): Rule[] {
  const lang = langOf(path);
  const code = stripComments(line, lang);
  const ctx: Ctx = { path, lang, raw: [line], code: [code] };
  return RULES.filter((r) => (r.files ? r.files.test(path) : r.langs === "any" || r.langs.includes(lang)))
    .filter((r) => { try { return r.match(ctx).some((h) => !h.guarded); } catch { return false; } });
}

/** Derives seeds from a fix patch: rules the removed lines violate that the added lines no longer do. */
export function seedsFromPatch(origin: string, title: string, patch: string): Seed[] {
  const seeds: Seed[] = [];
  for (const f of parsePatch(patch)) {
    const addedCalls = calls(f.added.join("\n"));
    const removedCalls = calls(f.removed.join("\n"));
    const guards = [...addedCalls].filter((c) => !removedCalls.has(c));
    const stillVulnerable = new Set(f.added.flatMap((l) => lineHits(f.path, l).map((r) => r.id)));
    const seen = new Set<string>();
    for (const line of f.removed) {
      const hits = lineHits(f.path, line).filter((r) => !stillVulnerable.has(r.id));
      for (const r of hits) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        seeds.push({ origin, title, file: f.path, rule: r.id, cwe: r.cwe, guards, anchors: [...calls(line)], removed: line.trim().slice(0, 200) });
      }
      // No rule applies but the fix wrapped something in a new call: keep the shape as a weaker seed.
      if (!hits.length && guards.length && calls(line).size && seeds.every((s) => s.file !== f.path || s.rule)) {
        const anchors = [...calls(line)].filter((c) => !guards.includes(c));
        if (anchors.length) seeds.push({ origin, title, file: f.path, guards, anchors, removed: line.trim().slice(0, 200) });
      }
    }
  }
  // Drop shape seeds that duplicate a rule seed from the same file.
  return seeds.filter((s, i) => s.rule || !seeds.some((o, j) => j !== i && o.file === s.file && o.rule));
}

/** Commit subjects that announce a security fix. */
export const SECURITY_COMMIT = /\b(security|vuln\w*|cve-\d{4}-\d+|ghsa-[\w-]+|xss|csrf|ssrf|sqli|sql injection|injection|traversal|rce|remote code|sanitiz\w*|escap\w*|auth(?:z|orization)? bypass|idor|privilege|open redirect|deserializ\w*|xxe|secret leak|leak)\b/i;
