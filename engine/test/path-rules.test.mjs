import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../packages/npm/cli.cjs", import.meta.url));
const PHP = (body) => `<?php\nfunction download() {\n${body}\n}\n`;
const RUBY = (body) => `def download\n${body}\nend\n`;
const CASES = [
  ["direct.php", PHP('  readfile($_GET["name"]);'), true],
  ["include.php", PHP('  include $_REQUEST["template"];'), true],
  ["require.php", PHP('  require_once($_GET["template"]);'), true],
  ["alias.php", PHP('  $name = $_GET["name"];\n  $path = "/data/" . $name;\n  file_get_contents($path);'), true],
  ["root-only.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  readfile($path);'), true],
  ["basename.php", PHP('  readfile("/data/" . basename($_GET["name"]));'), false],
  ["basename-alias.php", PHP('  $name = basename($_GET["name"]);\n  readfile("/data/" . $name);'), false],
  ["partial-sanitizer.php", PHP('  readfile(basename($_GET["safe"]) . $_GET["unsafe"]);'), true],
  ["unrelated.php", PHP('  $name = $_GET["name"];\n  basename($_GET["other"]);\n  readfile($name);'), true],
  ["confined.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) {\n    throw new Exception("outside");\n  }\n  readfile($path);'), false],
  ["weak-prefix.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  if (!str_starts_with($path, $root)) {\n    throw new Exception("outside");\n  }\n  readfile($path);'), true],
  ["late-guard.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  readfile($path);\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { throw new Exception("outside"); }'), true],
  ["not-a-guard.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { log_error("outside"); }\n  readfile($path);'), true],
  ["reassigned.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { throw new Exception("outside"); }\n  $path = $_GET["other"];\n  readfile($path);'), true],
  ["constant.php", PHP('  readfile("/data/help.txt");'), false],
  ["comment.php", PHP('  // readfile($_GET["name"]);'), false],
  ["direct.rb", RUBY('  send_file params[:name]'), true],
  ["read.rb", RUBY('  File.read(params.fetch(:name))'), true],
  ["alias.rb", RUBY('  name = params[:name]\n  path = Rails.root.join("data", name)\n  send_file path'), true],
  ["basename.rb", RUBY('  File.read("/data/" + File.basename(params[:name]))'), false],
  ["basename-alias.rb", RUBY('  name = File.basename(params[:name])\n  send_file "/data/" + name'), false],
  ["confined.rb", RUBY('  path = Rails.root.join("data", params[:name]).realpath\n  raise "outside" unless path.to_s.start_with?(root + File::SEPARATOR)\n  send_file path'), false],
  ["weak-prefix.rb", RUBY('  path = Rails.root.join("data", params[:name]).realpath\n  raise "outside" unless path.to_s.start_with?(root)\n  send_file path'), true],
  ["unrelated.rb", RUBY('  name = params[:name]\n  File.basename(params[:other])\n  File.read(name)'), true],
  ["constant.rb", RUBY('  send_file Rails.root.join("data", "help.txt")'), false],
  ["comment.rb", RUBY('  # send_file params[:name]'), false],
  ["same-line.php", PHP('  $name = $_GET["name"]; $path = "/data/" . $name; readfile($path);'), true],
  ["after-sink.php", PHP('  readfile($path); $path = $_GET["name"];'), false],
  ["unrelated-after.php", PHP('  readfile("/data/help.txt"); $unused = $_GET["name"];'), false],
  ["mixed-canonical.php", PHP('  $path = realpath("/data") . $_GET["name"];\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { throw new Exception("outside"); }\n  readfile($path);'), true],
  ["untrusted-root.php", PHP('  $root = $_GET["root"];\n  $path = realpath("/data/" . $_GET["name"]);\n  if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { throw new Exception("outside"); }\n  readfile($path);'), true],
  ["positive-guard.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  if (str_starts_with($path, $root . DIRECTORY_SEPARATOR)) {\n    readfile($path);\n  }'), false],
  ["fake-guard.php", PHP('  $path = realpath("/data/" . $_GET["name"]);\n  $example = \'if (!str_starts_with($path, $root . DIRECTORY_SEPARATOR)) { throw new Exception("outside"); }\';\n  readfile($path);'), true],
  ["quoted.php", PHP('  echo \'readfile($_GET["name"]);\';'), false],
  ["quoted.rb", RUBY('  puts "File.read(params[:name])"'), false],
  ["literal.php", PHP('  readfile(\'$_GET["name"]\');'), false],
  ["literal.rb", RUBY('  File.read(\'params[:name]\')'), false],
  ["interpolation.php", PHP('  readfile("/data/{$_GET[\'name\']}");'), true],
  ["interpolation.rb", RUBY('  File.read("/data/#{params[:name]}")'), true],
];

test("PHP and Ruby traversal candidates require request data on the sink path", () => {
  const dir = mkdtempSync(join(tmpdir(), "abl-path-rules-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [file, body] of CASES) writeFileSync(join(dir, file), body);
    const result = spawnSync(process.execPath, [CLI, "sinks", "--include-guarded"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const { candidates, guarded } = JSON.parse(result.stdout);
    for (const [file, , expected] of CASES) {
      const rule = file.endsWith(".php") ? "php.path.request-path" : "rb.path.request-path";
      const hits = candidates.filter(c => c.path === file && c.rule === rule);
      assert.equal(hits.length > 0, expected, `${file}: ${JSON.stringify(hits)}`);
      for (const hit of hits) {
        assert.equal(hit.cwe, "CWE-22");
        assert.ok(hit.line > 0);
      }
      if (file.startsWith("confined.")) {
        assert.ok(guarded.some(c => c.path === file && c.rule === rule), `${file}: missing guard evidence`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
