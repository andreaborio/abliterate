import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../packages/npm/cli.cjs", import.meta.url));
const replay = fileURLToPath(new URL("./fixtures/http", import.meta.url));

function setup(t, branch = "main") {
  const root = mkdtempSync(join(tmpdir(), "abl-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "local"), remote = join(root, "receiver.git");
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file",
    ABLITERATE_DEPS: "0", ABLITERATE_BLOCK: "1", ABLITERATE_AGENT: "", ABLITERATE_HTTP_REPLAY: replay };
  function run(exe, args, expected = 0) {
    const r = spawnSync(exe, args, { cwd: repo, env, encoding: "utf8" });
    assert.ifError(r.error);
    assert.equal(r.status, expected, `${args.join(" ")}\n${r.stderr}`);
    return r;
  }
  const git = (...args) => run("git", args).stdout.trim();
  const push = (args, code = 0) => run("git", ["push", "origin", ...args], code).stderr;
  const put = (file, text) => writeFileSync(join(repo, file), text);
  const save = (name) => { git("add", "."); git("commit", "-qm", name); return git("rev-parse", "HEAD"); };
  git("init", "-q", "--template=", "-b", branch);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("init", "-q", "--template=", "--bare", remote);
  git("remote", "add", "origin", remote);
  put("release options.txt", "rejectUnauthorized: true\n");
  const base = save("original settings");
  return { root, repo, remote, env, run, git, push, put, save, base,
    install: () => run(process.execPath, [cli, "hook", "install"]) };
}

test("a multi-ref push checks each outgoing tree instead of HEAD, the index or disk", (t) => {
  const { root, repo, env, git, push, put, save, base, install } = setup(t);
  push(["main"]);
  git("switch", "-qc", "warning");
  put("release options.txt", "rejectUnauthorized: false\n");
  put("tab\tsettings.txt", "rejectUnauthorized: false\n");
  put("package-lock.json", JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.20" } } }));
  put("label.js", "const get = require('lodash/get');\n");
  const warning = save("review candidate");
  git("tag", "-a", "preview", "-m", "release preview", warning);
  git("switch", "-qc", "clean", "main");
  put("readme.txt", "A harmless release note.\n");
  const clean = save("release note");
  install();
  const capture = join(root, "agent.log");
  // Exercise the same launch path without an account or model call.
  writeFileSync(join(root, "claude"), `#!/bin/sh
set -eu
test ! -e 'release options.txt'
git rev-parse HEAD >> "$CAPTURE"
git show 'HEAD:release options.txt' >> "$CAPTURE"
`);
  chmodSync(join(root, "claude"), 0o755);
  Object.assign(env, { PATH: root + ":" + env.PATH, CAPTURE: capture, ABLITERATE_AGENT: "claude", ABLITERATE_DEPS: "1" });
  // Staging introduces a candidate on disk's branch, even though the outgoing clean commit has none.
  put("release options.txt", "rejectUnauthorized: false\n");
  git("add", "release options.txt");
  put("release options.txt", "local only\n");
  put(".gitattributes", "*.txt -diff\n");
  const both = push(["clean", "warning"], 1);
  assert.ok(both.includes(`reviewing refs/heads/clean at ${clean} against ${base}`), both);
  assert.ok(both.includes(`reviewing refs/heads/warning at ${warning} against ${base}`), both);
  assert.match(both, /high-confidence candidates in refs\/heads\/warning/);
  assert.ok(both.includes("tab\tsettings.txt:1"), both);
  assert.doesNotMatch(both, /high-confidence candidates in refs\/heads\/clean/);
  assert.match(both, /lodash@4\.17\.20/);
  assert.match(both, /imported-symbol-not-seen/);
  const agentRead = readFileSync(capture, "utf8");
  assert.ok(agentRead.includes(clean + "\nrejectUnauthorized: true\n"));
  assert.ok(agentRead.includes(warning + "\nrejectUnauthorized: false\n"));
  assert.equal(git("ls-remote", "--heads", "origin", "clean", "warning"), "");
  push(["clean"]);
  assert.ok(git("ls-remote", "--heads", "origin", "clean").startsWith(clean));
  assert.ok(push(["refs/tags/preview"], 1).includes(`reviewing refs/tags/preview at ${warning}`));
  git("tag", "card-template", git("rev-parse", "HEAD:release options.txt"));
  assert.match(push(["refs/tags/card-template"]), /points to a blob; no commit to review/);
  assert.equal(readFileSync(join(repo, "release options.txt"), "utf8"), "local only\n");
  assert.equal(git("show", ":release options.txt"), "rejectUnauthorized: false");
  assert.doesNotMatch(push([":refs/heads/clean"]), /reviewing/);
});

test("a new ref with no comparable local base is incomplete and honors the blocking preference", (t) => {
  const { install, push, env } = setup(t, "trunk");
  install();
  assert.match(push(["trunk"], 1), /review incomplete.*no comparable local base/);
  env.ABLITERATE_BLOCK = "0";
  assert.match(push(["trunk"]), /review incomplete.*no comparable local base/);
});

test("a forced update compares the tree it replaces, even when rewinding history", (t) => {
  const { git, push, put, save, install } = setup(t);
  put("release options.txt", "rejectUnauthorized: false\n");
  const previous = save("older settings");
  put("release options.txt", "rejectUnauthorized: true\n");
  const fixed = save("restore verification");
  push(["main"]);
  install();
  git("replace", previous, fixed);
  assert.ok(push([`+${previous}:refs/heads/main`], 1).includes(`reviewing refs/heads/main at ${previous} against ${fixed}`));
  assert.ok(git("ls-remote", "--heads", "origin", "main").startsWith(fixed));
});
