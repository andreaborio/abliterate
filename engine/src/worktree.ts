import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_BYTES } from "./lang";

/** Read an ordinary checkout file, following links only if their final target is in the checkout. */
export function readWorktreeText(root: string, path: string, maxBytes = MAX_BYTES): string | undefined {
  if (isAbsolute(path) || path.split(sep).includes("..")) return undefined;
  let fd: number | undefined;
  try {
    const checkout = realpathSync.native(root);
    const requested = resolve(checkout, path);
    const target = realpathSync.native(requested);
    const rel = relative(checkout, target);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return undefined;

    const expected = statSync(target, { bigint: true });
    if (!expected.isFile() || expected.size > maxBytes) return undefined;
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    // Read from the checked descriptor even if a file or one of its parents is replaced.
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino
        || opened.size > maxBytes || realpathSync.native(requested) !== target) return undefined;
    const text = readFileSync(fd, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
