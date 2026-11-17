import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeScope, readAt, trackedFiles, type Scope, type State } from "./git";
import { langOf, MAX_BYTES, skipPath, stripComments } from "./lang";
import { RULES, type Ctx, type Rule } from "./rules";

export type Where = State | "untracked" | null;

export interface Candidate {
  rule: string;
  cwe: string;
  title: string;
  confidence: Rule["confidence"];
  path: string;
  line: number;
  /** Which snapshot changed this line; null = present before the change. */
  changedIn: Where;
  snippet: string;
  guarded?: string;
  note?: string;
}

const SECRET_RULE = "any.secret.credential-literal";

function redact(text: string): string {
  return text.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_/+=.-]{8,}/g, (m, keep: string) => (m.length >= 16 ? `${keep}…[redacted]` : m));
}

function snippet(line: string, rule: string): string {
  const t = line.trim().replace(/\s+/g, " ");
  const s = rule === SECRET_RULE ? redact(t) : t;
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}

function readDisk(root: string, path: string): string | undefined {
  try {
    const p = join(root, path);
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    const text = readFileSync(p, "utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

export function scanText(path: string, text: string, rules: Rule[] = RULES) {
  const lang = langOf(path);
  const raw = text.split(/\r?\n/);
  const ctx: Ctx = { path, lang, raw, code: stripComments(text, lang).split(/\r?\n/) };
  const out: { rule: Rule; line: number; guarded?: string; note?: string }[] = [];
  for (const rule of rules) {
    if (rule.files ? !rule.files.test(path) : rule.langs !== "any" && !rule.langs.includes(lang)) continue;
    if (rule.files && rule.langs !== "any" && !rule.langs.includes(lang)) continue;
    for (const h of rule.match(ctx)) out.push({ rule, ...h });
  }
  return { raw, hits: out };
}

const inHunks = (hunks: [number, number][] | undefined, line: number) => !!hunks?.some(([s, n]) => line >= s && line < s + n);

export interface ScanResult {
  scope: Scope;
  candidates: Candidate[];
  guarded: Candidate[];
  files: number;
}

/**
 * Scans the files that matter for a review. With `changedOnly`, only files touched in the
 * push, index or working tree (plus untracked). Each changed snapshot is scanned in its own
 * content so line numbers match that snapshot, never mixed.
 */
export function scan(cwd: string, opts: { base?: string; changedOnly?: boolean; rules?: Rule[] }): ScanResult {
  const scope = computeScope(cwd, opts.base);
  const { root, states } = scope;
  const byState = (s: State) => new Map(states[s].filter((f) => f.status !== "deleted").map((f) => [f.path, f.hunks]));
  const push = byState("push");
  const index = byState("index");
  const work = byState("worktree");
  const untracked = new Set(scope.untracked);

  const files = new Set<string>(
    opts.changedOnly ? [...push.keys(), ...index.keys(), ...work.keys(), ...untracked] : [...trackedFiles(root), ...untracked],
  );
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const guarded: Candidate[] = [];

  const emit = (path: string, text: string, where: (line: number) => Where, onlyChanged: boolean) => {
    const { raw, hits } = scanText(path, text, opts.rules);
    for (const h of hits) {
      const changedIn = where(h.line);
      if (onlyChanged && changedIn === null) continue;
      const key = `${h.rule.id}|${path}|${h.line}|${changedIn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c: Candidate = {
        rule: h.rule.id, cwe: h.rule.cwe, title: h.rule.title, confidence: h.rule.confidence, path, line: h.line, changedIn,
        snippet: snippet(raw[h.line - 1] ?? "", h.rule.id),
        ...(h.guarded ? { guarded: h.guarded } : {}), ...(h.note ? { note: h.note } : {}),
      };
      (h.guarded ? guarded : candidates).push(c);
    }
  };

  let scanned = 0;
  for (const path of [...files].sort()) {
    if (skipPath(path)) continue;
    const disk = readDisk(root, path);
    const localEdits = index.has(path) || work.has(path);
    if (untracked.has(path)) {
      if (disk !== undefined) { emit(path, disk, () => "untracked", false); scanned++; }
      continue;
    }
    if (!localEdits) {
      if (disk !== undefined) { emit(path, disk, (l) => (inHunks(push.get(path), l) ? "push" : null), false); scanned++; }
      continue;
    }
    // The file differs between HEAD, index and disk: scan each snapshot in its own content.
    if (push.has(path)) { const t = readAt(root, "push", path); if (t !== undefined) emit(path, t, (l) => (inHunks(push.get(path), l) ? "push" : null), true); }
    if (index.has(path)) { const t = readAt(root, "index", path); if (t !== undefined) emit(path, t, (l) => (inHunks(index.get(path), l) ? "index" : null), true); }
    if (disk !== undefined) emit(path, disk, (l) => (inHunks(work.get(path), l) ? "worktree" : null), false);
    scanned++;
  }

  const order = (c: Candidate) => (c.changedIn ? 0 : 1);
  const conf = { high: 0, medium: 1, low: 2 } as const;
  const sort = (a: Candidate, b: Candidate) => order(a) - order(b) || conf[a.confidence] - conf[b.confidence] || a.path.localeCompare(b.path) || a.line - b.line;
  return { scope, candidates: candidates.sort(sort), guarded: guarded.sort(sort), files: scanned };
}
