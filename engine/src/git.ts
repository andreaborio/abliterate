import { git, safeRef, UsageError } from "./util";
import { MAX_BYTES } from "./lang";

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
  comparisonBase?: string;
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

// Git quotes control characters in patch headers even with core.quotePath=false.
function patchPath(value: string): string {
  if (!value.startsWith('"')) return value.replace(/\t$/, "");
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return value.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, escape: string) =>
    /^[0-7]{3}$/.test(escape) ? String.fromCharCode(parseInt(escape, 8)) : escapes[escape] ?? escape);
}

/** Parses `git diff --unified=0` output into per-file hunks in the new version. */
export function parseDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: "", status: "modified", hunks: [] };
      inHunk = false;
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (!inHunk && line.startsWith("rename from ")) { cur.status = "renamed"; cur.from = patchPath(line.slice(12)); }
    else if (!inHunk && line.startsWith("rename to ")) cur.path = patchPath(line.slice(10));
    else if (!inHunk && line.startsWith("--- ") && cur.status === "deleted") cur.path = patchPath(line.slice(4)).replace(/^a\//, "");
    else if (!inHunk && line.startsWith("+++ ") && line !== "+++ /dev/null") cur.path = patchPath(line.slice(4)).replace(/^b\//, "");
    else if (line.startsWith("@@")) {
      inHunk = true;
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
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", "-M"];

export function computeScope(cwd: string, explicitBase?: string, explicitHead?: string): Scope {
  const root = repoRoot(cwd);
  const notes: string[] = [];
  if (explicitHead && !explicitBase) throw new UsageError("--head requires an explicit --base");
  const ref = explicitHead ? safeRef(explicitHead) : "HEAD";
  const head = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }).trim() || undefined;
  if (explicitHead && !head) throw new UsageError(`head "${explicitHead}" is not a commit in this clone`);
  const base = resolveBase(root, explicitBase);
  let mergeBase: string | undefined;
  let comparisonBase: string | undefined;
  let push: FileChange[] = [];
  let commits: Scope["commits"] = [];
  if (!head) notes.push("No commits yet: only index and working tree can be reviewed.");
  else if (!base) notes.push("No base found (no upstream, main or master): the push state was not computed. Pass --base.");
  else {
    mergeBase = git(root, ["merge-base", base, head], { allowFail: true }).trim() || undefined;
    // An existing ref is being replaced, including on a forced update. Compare its actual trees.
    comparisonBase = explicitHead ? git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim() : mergeBase;
    if (!comparisonBase) notes.push(`No common ancestor between ${base} and HEAD (shallow or unrelated history): push state not computed.`);
    else {
      const attributes = explicitHead ? [`--attr-source=${head}`] : [];
      push = parseDiff(git(root, [...attributes, "-c", "core.quotePath=false", ...DIFF, comparisonBase, head, "--"]));
      commits = git(root, ["log", "--format=%H%x09%s", `${comparisonBase}..${head}`]).trim().split("\n").filter(Boolean)
        .map((l) => { const [sha, ...s] = l.split("\t"); return { sha: sha!, subject: s.join("\t") }; });
    }
    if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") notes.push("Shallow clone: history-based checks may be incomplete.");
  }
  if (explicitHead) return { root, base, mergeBase, comparisonBase, head, commits, states: { push, index: [], worktree: [] }, untracked: [], notes };
  const index = head ? parseDiff(git(root, ["-c", "core.quotePath=false", ...DIFF, "--cached"])) : [];
  const worktree = parseDiff(git(root, ["-c", "core.quotePath=false", ...DIFF]));
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  return { root, base, mergeBase, head, commits, states: { push, index, worktree }, untracked, notes };
}

/** File content as it exists in a state: push = HEAD, index = staged blob, worktree = disk (caller reads). */
export function readAt(root: string, state: Exclude<State, "worktree">, path: string): string | undefined {
  const spec = state === "push" ? `HEAD:${path}` : `:${path}`;
  const out = git(root, ["cat-file", "-p", spec], { allowFail: true });
  return out || undefined;
}

export const trackedFiles = (root: string) =>
  git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);

/** Regular files in a Git tree. Read the raw blob; never check out files or apply attributes. */
export function commitTree(root: string, sha: string, paths?: string[]) {
  const blobs = new Map<string, { oid: string; size: number }>();
  const args = ["--literal-pathspecs", "ls-tree", "-rlz", "--full-tree", sha, "--"];
  const collect = (selected: string[]) => {
    for (const entry of git(root, [...args, ...selected]).split("\0")) {
      const match = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(entry);
      if (match) blobs.set(match[3]!, { oid: match[1]!, size: Number(match[2]) });
    }
  };
  if (paths) {
    for (let i = 0; i < paths.length; i += 32) collect(paths.slice(i, i + 32));
  } else {
    collect([]);
  }
  return {
    paths: [...blobs.keys()],
    read(path: string, maxBytes = MAX_BYTES): string | undefined {
      const blob = blobs.get(path);
      if (!blob || blob.size > maxBytes) return undefined;
      const text = git(root, ["cat-file", "blob", blob.oid]);
      return text.includes("\0") ? undefined : text;
    },
  };
}
