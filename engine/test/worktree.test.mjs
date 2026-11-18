import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../packages/npm/cli.cjs", import.meta.url));
const replay = fileURLToPath(new URL("./fixtures/http/", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "abl-worktree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "project");
  const outside = join(dir, "project-backup");
  mkdirSync(repo);
  mkdirSync(outside);
  const git = (...args) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", ...args,
  ], { cwd: repo });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "page.js"), "const page = 'draft';\n");
  git("add", "src/page.js");
  renameSync(join(repo, "src"), join(repo, "original"));
  symlinkSync(outside, join(repo, "src"), "dir");
  writeFileSync(join(outside, "page.js"), "import _ from 'lodash';\napp.get('/external', handler);\n");
  symlinkSync(join(outside, "page.js"), join(repo, "external.js"));
  writeFileSync(join(repo, "inside.js"), "app.get('/local', handler);\n");
  symlinkSync("inside.js", join(repo, "alias.js"));

  const run = (...args) => execFileSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, ABLITERATE_HTTP_REPLAY: replay },
  });
  return { repo, outside, run, git };
}

test("local evidence follows in-tree files and excludes external links and linked ancestors", (t) => {
  const { repo, outside, run } = fixture(t);
  const routes = JSON.parse(run("surface")).entryPoints.map((e) => e.path);
  assert.deepEqual(routes.sort(), ["alias.js", "inside.js"]);

  // Only inside.js, alias.js and the ordinary file moved to original/ are in scope.
  assert.equal(JSON.parse(run("sinks")).filesScanned, 3);
  writeFileSync(join(outside, "requirements.txt"), "external-marker==1.0.0\n");
  symlinkSync(join(outside, "requirements.txt"), join(repo, "requirements.txt"));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.20" } } }));
  assert.deepEqual(JSON.parse(run("deps", "--inventory")).packages.map((p) => p.name), ["lodash"]);
  const deps = JSON.parse(run("deps", "--offline"));
  assert.ok(deps.vulnerable.some((v) => v.package === "lodash"));
  assert.deepEqual(deps.vulnerable[0].imports, []);
  assert.equal(deps.complete, false, "a skipped dependency manifest leaves the inventory incomplete");
});

test("SARIF uses its ordinary missing-file fingerprint for an external target", (t) => {
  const { repo, outside, run } = fixture(t);
  const finding = {
    id: "local", title: "Review the directory contract", status: "needs-evidence", severity: "low",
    confidence: "low", cwe: ["CWE-200"], snapshot: "file", source: "review",
    location: { path: "src/page.js", startLine: 1 }, rule: "Show public fields", actor: "member",
    impact: "Pending evidence", evidence: "Fixture only", decisiveEvidence: "The route contract",
  };
  writeFileSync(join(repo, "findings.json"), JSON.stringify({
    version: 1, scope: { states: ["file"], complete: false }, findings: [finding],
  }));
  function fingerprint() {
    run("report", "--in", "findings.json", "--include-unconfirmed", "--sarif", "out.sarif");
    return JSON.parse(readFileSync(join(repo, "out.sarif"), "utf8")).runs[0].results[0].partialFingerprints;
  }
  const linked = fingerprint();
  renameSync(join(outside, "page.js"), join(outside, "renamed.js"));
  assert.deepEqual(linked, fingerprint());
});

test("variant call-shape comparison uses only in-tree source", (t) => {
  const { repo, outside, run, git } = fixture(t);
  const put = (file, body) => writeFileSync(join(repo, file), body);
  put("labels.js", "displayLabel(value);\n");
  git("add", "labels.js");
  git("commit", "-qm", "Format labels");
  put("labels.js", "displayLabel(normalize(value));\n");
  git("add", "labels.js");
  git("commit", "-qm", "Security maintenance: normalize display labels");
  put("local.js", "displayLabel(otherValue);\n");
  writeFileSync(join(outside, "page.js"), "displayLabel(externalValue);\n");
  const { variants } = JSON.parse(run("variants", "--history", "--offline"));
  assert.deepEqual(variants.map((v) => v.path), ["local.js"]);
});
