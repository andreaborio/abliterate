import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const engine = fileURLToPath(new URL("../../bin/abliterate", import.meta.url));
const script = fileURLToPath(new URL("../../action/report.sh", import.meta.url));
const report = (note) => JSON.stringify({ version: 1, scope: { states: ["push"], complete: true, note }, findings: [] });

test("the Action publishes only a valid report from a successful agent in this run", (t) => {
  const root = mkdtempSync(join(tmpdir(), "abliterate-action-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".abliterate"), { recursive: true });
  const checkoutReport = join(checkout, ".abliterate", "findings.json");
  writeFileSync(checkoutReport, report("tracked file"));

  for (const [outcome, agentFile, expected] of [
    ["false", report("unfinished review"), "engine evidence"],
    ["true", undefined, "engine evidence"],
    ["true", "{}", "engine evidence"],
    ["true", report("reviewed this run"), "reviewed this run"],
  ]) {
    const dir = mkdtempSync(join(root, "run-"));
    mkdirSync(join(dir, "agent"));
    if (agentFile) writeFileSync(join(dir, "agent/findings.json"), agentFile);
    writeFileSync(join(dir, "draft.json"), report("engine evidence"));
    writeFileSync(join(dir, "high-candidates.txt"), "0\n");
    const proc = spawnSync("bash", [script], {
      cwd: checkout, encoding: "utf8",
      env: { ...process.env, ABL: engine, ABL_RUN_DIR: dir, AGENT: "claude", AGENT_SUCCEEDED: outcome,
        BLOCK_CANDIDATES: "false", FAIL_ON: "high", GITHUB_OUTPUT: join(dir, "outputs"), GITHUB_STEP_SUMMARY: join(dir, "summary") },
    });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, "findings.json"))).scope.note, expected);
    assert.ok(readFileSync(join(dir, "outputs"), "utf8").includes(`sarif=${dir}/results.sarif\n`));
    assert.equal(readFileSync(checkoutReport, "utf8"), report("tracked file"));
  }
});
