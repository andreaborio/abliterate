import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { allowFlags, EXIT, git, UsageError, VERSION, type Flags } from "../util";

export const HOOK_HELP = `abliterate hook install|uninstall [--force]
  Installs a git pre-push hook that runs a fast evidence pass (sinks and deps) on what you are about to push.
  Non-blocking by default. Environment, read at push time:
    ABLITERATE_BLOCK=1        fail the push when a high-confidence candidate is in the pushed commits
    ABLITERATE_DEPS=0         skip the dependency lookup (no network)
    ABLITERATE_AGENT=claude   also run a full review with Claude Code (claude -p), or "codex" (codex exec)
  --force replaces an existing pre-push hook, keeping it as pre-push.abliterate-backup.`;

const MARKER = "# abliterate-pre-push-hook";

/** How the hook should call the engine: the same file when installed, a pinned npx otherwise. */
function engineCommand(): string {
  const self = process.argv[1] ? resolve(process.argv[1]) : "";
  if (self && !/[\\/]_npx[\\/]/.test(self) && existsSync(self)) return `node '${self.replace(/'/g, "'\\''")}'`;
  return `npx -y abliterate@${VERSION}`;
}

function script(engine: string): string {
  return `#!/bin/sh
${MARKER} (abliterate ${VERSION})
# Fast security evidence for the commits being pushed. Remove with: abliterate hook uninstall
abl() { ${engine} "$@"; }
zero=0000000000000000000000000000000000000000
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$remote_sha" = "$zero" ] || ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    base=$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo "")
    [ -z "$base" ] && for b in origin/main origin/master main master; do git rev-parse -q --verify "$b^{commit}" >/dev/null && base=$b && break; done
  else
    base=$remote_sha
  fi
  [ -z "$base" ] && { echo "abliterate: no base to compare $local_ref against; skipping." >&2; continue; }
  echo "abliterate: evidence for $local_ref against $base" >&2
  out=$(abl sinks --changed --base "$base" --format md 2>&1) || { echo "$out" >&2; continue; }
  echo "$out" >&2
  if [ "\${ABLITERATE_DEPS:-1}" != "0" ]; then
    abl deps --changed --base "$base" --format md >&2 2>&1 || true
  fi
  if [ "\${ABLITERATE_BLOCK:-0}" = "1" ] && echo "$out" | grep -q '^| push | .* | high |'; then
    echo "abliterate: high-confidence candidates in the pushed commits (ABLITERATE_BLOCK=1). Review them or push with --no-verify." >&2
    status=1
  fi
  case "\${ABLITERATE_AGENT:-}" in
    claude) claude -p "$(abl review --since "$base")" --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(npx -y abliterate*),Bash(abliterate:*)" >&2 || true ;;
    codex) codex exec --sandbox read-only "$(abl review --since "$base")" >&2 || true ;;
  esac
done
exit $status
`;
}

export function hook(flags: Flags, cwd: string): number {
  allowFlags(flags, ["force"]);
  const action = flags._[0];
  if (action !== "install" && action !== "uninstall") throw new UsageError("hook needs install or uninstall");
  // The real hooks directory honours core.hooksPath, which the hardened git() wrapper overrides.
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new UsageError("not inside a git repository");
  const hooksDir = r.stdout.trim();
  const dir = isAbsolute(hooksDir) ? hooksDir : join(git(cwd, ["rev-parse", "--show-toplevel"]).trim(), hooksDir);
  const file = join(dir, "pre-push");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const ours = existing?.includes(MARKER) ?? false;

  if (action === "uninstall") {
    if (!existing) { process.stdout.write("No pre-push hook installed.\n"); return EXIT.ok; }
    if (!ours) throw new UsageError(`${file} was not installed by abliterate; leaving it in place`);
    unlinkSync(file);
    if (existsSync(file + ".abliterate-backup")) renameSync(file + ".abliterate-backup", file);
    process.stdout.write(`Removed ${file}.\n`);
    return EXIT.ok;
  }
  if (existing && !ours) {
    if (flags.force !== true) throw new UsageError(`${file} already exists and is not abliterate's; rerun with --force to replace it (it will be kept as pre-push.abliterate-backup)`);
    renameSync(file, file + ".abliterate-backup");
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script(engineCommand()));
  chmodSync(file, 0o755);
  process.stdout.write(`Installed ${file}. It never blocks unless ABLITERATE_BLOCK=1; see "abliterate hook --help".\n`);
  return EXIT.ok;
}
