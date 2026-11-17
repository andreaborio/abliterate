import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv = require("ajv-draft-04");
const CLI = new URL("../../packages/npm/cli.cjs", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(new URL("./vendor/sarif-schema-2.1.0.json", import.meta.url)));

const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

const finding = (over = {}) => ({
  id: "ABL-1", title: "SQL injection in user search", status: "confirmed", severity: "high", confidence: "high",
  cwe: ["CWE-89"], snapshot: "push", source: "review",
  location: { path: "src/routes/users.js", startLine: 2 },
  rule: "Query values are always bound as parameters", actor: "any visitor", impact: "Reads every row of users.",
  evidence: "req.query.q is interpolated into the SQL text.", fix: "Bind term as $1.", test: "A search for O'Brien returns rows and no SQL error.",
  trace: [{ path: "src/routes/users.js", startLine: 1, note: "source: req.query.q" }],
  ...over,
});

function workspace(report) {
  const dir = mkdtempSync(join(tmpdir(), "abl-report-"));
  mkdirSync(join(dir, "src/routes"), { recursive: true });
  writeFileSync(join(dir, "src/routes/users.js"), "const term = req.query.q;\ndb.query(`SELECT * FROM users WHERE name = '${term}'`);\n");
  writeFileSync(join(dir, "findings.json"), JSON.stringify(report));
  return dir;
}

test("valid report produces schema-valid SARIF and markdown", () => {
  const dir = workspace({ version: 1, scope: { base: "main", head: "abc123", states: ["push"], complete: true }, findings: [
    finding(),
    finding({ id: "ABL-2", status: "needs-evidence", severity: "medium", fix: undefined, test: undefined, decisiveEvidence: "The route's auth middleware config." }),
    finding({ id: "ABL-3", source: "deps", cwe: ["CWE-94"], location: { path: "package-lock.json", startLine: 1 },
      advisory: { id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], ecosystem: "npm", package: "lodash", version: "4.17.20", fixed: "4.17.21", kev: false, epss: 0.01 } }),
  ] });
  const r = run(["report", "--in", "findings.json", "--sarif", "out.sarif", "--md", "out.md"], dir);
  assert.equal(r.status, 0, r.stderr);
  const sarif = JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const ok = ajv.validate(schema, sarif);
  assert.ok(ok, JSON.stringify(ajv.errors, null, 2));
  const results = sarif.runs[0].results;
  assert.equal(results.length, 2, "needs-evidence is excluded by default");
  assert.ok(results.every((x) => x.partialFingerprints["abliterate/v1"].length === 64));
  assert.equal(sarif.runs[0].tool.driver.rules.find((x) => x.id === "CWE-89").properties["security-severity"], "7.5");
  const md = readFileSync(join(dir, "out.md"), "utf8");
  assert.match(md, /No confirmed vulnerabilities introduced|Review:/);
  assert.match(md, /Needs evidence/);
});

test("fail-on blocks on confirmed findings at or above the threshold", () => {
  const dir = workspace({ version: 1, scope: { states: ["push"], complete: true }, findings: [finding()] });
  assert.equal(run(["report", "--in", "findings.json", "--fail-on", "high"], dir).status, 1);
  assert.equal(run(["report", "--in", "findings.json", "--fail-on", "critical"], dir).status, 0);
});

test("invalid report lists every problem with its path", () => {
  const dir = workspace({ version: 1, scope: { states: ["push"] }, findings: [finding({ cwe: ["89"], location: { path: "../etc/passwd", startLine: 0 }, fix: undefined })] });
  const r = run(["report", "--in", "findings.json"], dir);
  assert.equal(r.status, 2);
  for (const needle of ["scope.complete", "findings[0].cwe[0]", "findings[0].location.path", "findings[0].location.startLine", "findings[0].fix"]) {
    assert.ok(r.stderr.includes(needle), `missing ${needle} in:\n${r.stderr}`);
  }
});

test("fingerprint is stable when the finding moves to another line", () => {
  const base = { version: 1, scope: { states: ["push"], complete: true }, findings: [finding()] };
  const a = workspace(base);
  run(["report", "--in", "findings.json", "--sarif", "a.sarif"], a);
  const b = workspace({ ...base, findings: [finding({ location: { path: "src/routes/users.js", startLine: 3 } })] });
  writeFileSync(join(b, "src/routes/users.js"), "// moved\nconst term = req.query.q;\ndb.query(`SELECT * FROM users WHERE name = '${term}'`);\n");
  run(["report", "--in", "findings.json", "--sarif", "b.sarif"], b);
  const fp = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8")).runs[0].results[0].partialFingerprints["abliterate/v1"];
  assert.equal(fp(a, "a.sarif"), fp(b, "b.sarif"));
});
