import { spawnSync } from "node:child_process";

declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

export class UsageError extends Error {}

/** Exit codes: 0 ok, 1 findings at/above --fail-on, 2 usage or input error, 3 environment error. */
export const EXIT = { ok: 0, findings: 1, usage: 2, env: 3 } as const;

export interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

/** Minimal, strict flag parser: --key value, --key=value, --flag. Unknown flags are rejected by callers. */
export function parseArgs(argv: string[], booleans: string[] = []): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (booleans.includes(k)) { out[k] = v === undefined ? true : v !== "false"; continue; }
      const val = v ?? argv[++i];
      if (val === undefined) throw new UsageError(`--${k} needs a value`);
      out[k] = val;
    } else out._.push(a);
  }
  return out;
}

export function allowFlags(flags: Flags, allowed: string[]) {
  for (const k of Object.keys(flags)) if (k !== "_" && !allowed.includes(k)) throw new UsageError(`unknown option --${k}`);
}

export const str = (flags: Flags, k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

/** A git ref we are willing to pass to git: no options, no ranges, no shell metacharacters. */
export function safeRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,199}$/.test(ref) || ref.includes("..")) throw new UsageError(`unsafe git ref: ${ref}`);
  return ref;
}

/**
 * Runs git read-only with repository-controlled helpers disabled: no external diff,
 * no textconv, no fsmonitor, no pager, hooks pointed at /dev/null.
 */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const r = spawnSync("git", [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
    "-c", "core.pager=cat", "--no-pager", ...args,
  ], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat", LC_ALL: "C" } });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.status === 0 ? r.stdout : "";
}

export function print(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
