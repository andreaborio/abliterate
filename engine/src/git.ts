import { git, safeRef, UsageError } from "./util";

export type State = "push" | "index" | "worktree";

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  from?: string;
  /** Changed line ranges in the new version: [start, length]. */
  hunks: [number, number][];
}

export interface Scope {
  root: string;
  base?: string;
  mergeBase?: string;
  head?: string;
  commits: { sha: string; subject: string }[];
  states: Record<State, FileChange[]>;
  untracked: string[];
  notes: string[];
}

export const repoRoot = (cwd: string) => git(cwd, ["rev-parse", "--show-toplevel"]).trim();

/** The base to compare against: the explicit ref, else the upstream, else main/master. Never fetches. */
export function resolveBase(root: string, explicit?: string): string | undefined {
  if (explicit) {
    safeRef(explicit);
    if (!git(root, ["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`], { allowFail: true }).trim()) {
      throw new UsageError(`base "${explicit}" is not a commit in this clone (no fetch is done; fetch it yourself or pass another ref)`);
    }
    return explicit;
  }
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFail: true }).trim();
  for (const candidate of [upstream, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { allowFail: true }).trim()) return candidate;
  }
  return undefined;
}

/** Parses `git diff --unified=0` output into per-file hunks in the new version. */
export function parseDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: "", status: "modified", hunks: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) { cur.status = "renamed"; cur.from = line.slice(12); }
    else if (line.startsWith("--- ") && cur.status === "deleted") cur.path = line.slice(4).replace(/^a\//, "");
    else if (line.startsWith("+++ ") && line !== "+++ /dev/null") cur.path = line.slice(4).replace(/^b\//, "");
    else if (line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        const len = m[2] === undefined ? 1 : Number(m[2]);
        if (len > 0) cur.hunks.push([Number(m[1]), len]);
      }
    }
  }
  return files.filter((f) => f.path);
}

// Never run repository-configured diff drivers or textconv filters on untrusted content.
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "-M"];

export function computeScope(cwd: string, explicitBase?: string): Scope {
  const root = repoRoot(cwd);
  const notes: string[] = [];
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true }).trim() || undefined;
  const base = resolveBase(root, explicitBase);
  let mergeBase: string | undefined;
  let push: FileChange[] = [];
  let commits: Scope["commits"] = [];
  if (!head) notes.push("No commits yet: only index and working tree can be reviewed.");
  else if (!base) notes.push("No base found (no upstream, main or master): the push state was not computed. Pass --base.");
  else {
    mergeBase = git(root, ["merge-base", base, "HEAD"], { allowFail: true }).trim() || undefined;
    if (!mergeBase) notes.push(`No common ancestor between ${base} and HEAD (shallow or unrelated history): push state not computed.`);
    else {
      push = parseDiff(git(root, ["-c", "core.quotePath=false", ...DIFF, mergeBase, "HEAD"]));
      commits = git(root, ["log", "--format=%H%x09%s", `${mergeBase}..HEAD`]).trim().split("\n").filter(Boolean)
        .map((l) => { const [sha, ...s] = l.split("\t"); return { sha: sha!, subject: s.join("\t") }; });
    }
    if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") notes.push("Shallow clone: history-based checks may be incomplete.");
  }
  const index = head ? parseDiff(git(root, ["-c", "core.quotePath=false", ...DIFF, "--cached"])) : [];
  const worktree = parseDiff(git(root, ["-c", "core.quotePath=false", ...DIFF]));
  const untracked = git(root, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return { root, base, mergeBase, head, commits, states: { push, index, worktree }, untracked, notes };
}

/** File content as it exists in a state: push = HEAD, index = staged blob, worktree = disk (caller reads). */
export function readAt(root: string, state: Exclude<State, "worktree">, path: string): string | undefined {
  const spec = state === "push" ? `HEAD:${path}` : `:${path}`;
  const out = git(root, ["cat-file", "-p", spec], { allowFail: true });
  return out || undefined;
}

export const trackedFiles = (root: string) =>
  git(root, ["-c", "core.quotePath=false", "ls-files"]).split("\n").filter(Boolean);
