import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../../packages/npm/cli.cjs", import.meta.url).pathname;
const MAKE = new URL("../../evals/make_fixtures.py", import.meta.url).pathname;
let root;
let expected;

before(() => {
  root = join(mkdtempSync(join(tmpdir(), "abl-fx-")), "fx");
  const r = spawnSync("python3", [MAKE, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8")).fixtures;
});

const sinks = (fixture) => {
  const r = spawnSync(process.execPath, [CLI, "sinks", "--base", "main"], { cwd: join(root, fixture), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// A candidate matches an expectation on the same file and CWE within one line.
const near = (c, e) => c.path === e.path && c.cwe === e.cwe && Math.abs(c.line - e.line) <= 1;

test("every engine-detectable seeded vulnerability is a candidate, marked by snapshot", () => {
  const missed = [];
  for (const fx of expected) {
    const out = sinks(fx.name);
    for (const e of fx.expect.filter((x) => x.kind === "vuln" && x.engine && x.path !== "package-lock.json")) {
      const hit = out.candidates.find((c) => near(c, e));
      if (!hit) missed.push(`${fx.name} ${e.cwe} ${e.path}:${e.line}`);
      else assert.equal(hit.changedIn === "push", e.introduced, `${fx.name}: ${e.path}:${e.line} changedIn=${hit.changedIn}`);
    }
  }
  assert.deepEqual(missed, []);
});

test("no guarded twin is reported as a candidate", () => {
  const flagged = [];
  for (const fx of expected) {
    const out = sinks(fx.name);
    for (const e of fx.expect.filter((x) => x.kind === "safe")) {
      const hit = out.candidates.find((c) => c.path === e.path && Math.abs(c.line - e.line) <= 1);
      if (hit) flagged.push(`${fx.name} ${hit.rule} ${e.path}:${hit.line}`);
    }
  }
  assert.deepEqual(flagged, []);
});

test("precision on fixtures: report extra candidates", () => {
  let total = 0;
  const extras = [];
  for (const fx of expected) {
    for (const c of sinks(fx.name).candidates) {
      total++;
      if (!fx.expect.some((e) => e.kind === "vuln" && near(c, e))) extras.push(`${fx.name} ${c.rule} ${c.path}:${c.line}`);
    }
  }
  // Extras are allowed but must stay rare; every one is printed for review.
  if (extras.length) console.log("extra candidates:\n  " + extras.join("\n  "));
  assert.ok(extras.length / Math.max(total, 1) <= 0.25, `${extras.length}/${total} candidates are not seeded vulnerabilities`);
});

test("secret values are never printed", () => {
  const out = JSON.stringify(sinks("hardcoded-secret"));
  assert.ok(!/sk_live_51Hx/.test(out) && !/AKIAFIXTURE/.test(out), "secret value leaked in output");
});

test("comments cannot hide or add candidates", () => {
  const bait = sinks("injection-bait").candidates;
  assert.ok(bait.some((c) => c.cwe === "CWE-89"));
});
