import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../../packages/npm/cli.cjs", import.meta.url).pathname;

// [file, code, rule expected or null when the line must stay quiet]
const CASES = [
  ["a.go", 'rows, _ := db.Query(fmt.Sprintf("SELECT * FROM t WHERE id = %s", id))', "go.sql.sprintf-query"],
  ["b.go", 'rows, _ := db.Query("SELECT * FROM t WHERE id = $1", id)', null],
  ["c.go", 'cmd := exec.Command("sh", "-c", userScript)', "go.cmd.shell"],
  ["d.go", 'tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}', "any.tls.verification-disabled"],
  ["A.java", 'stmt.executeQuery("SELECT * FROM users WHERE name = \'" + name + "\'");', "java.sql.concatenated-query"],
  ["B.java", 'PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE name = ?");', null],
  ["C.java", 'Object o = new ObjectInputStream(request.getInputStream()).readObject();', "java.deser.object-input"],
  ["a.rb", 'User.where("name = \'#{params[:name]}\'")', "rb.sql.interpolated-where"],
  ["b.rb", 'User.where(name: params[:name])', null],
  ["c.rb", 'system("convert #{params[:file]} out.png")', "rb.cmd.interpolated"],
  ["a.php", '$r = mysqli_query($db, "SELECT * FROM t WHERE id = " . $_GET["id"]);', "php.sql.concatenated-query"],
  ["b.php", '$data = unserialize($_COOKIE["prefs"]);', "php.deser.unserialize"],
  ["c.js", 'const token = Math.random().toString(36).slice(2); // reset token', "any.crypto.weak-random-token"],
  ["d.js", 'const id = crypto.randomUUID();', null],
  ["e.js", 'https.request({ host, rejectUnauthorized: false })', "any.tls.verification-disabled"],
  ["f.js", 'res.redirect(req.query.next);', "js.redirect.request-target"],
  ["g.py", 'data = yaml.load(body)', "py.deser.unsafe-loader"],
  ["h.py", 'data = yaml.load(body, Loader=yaml.SafeLoader)', null],
  ["i.py", 'requests.get(url, verify=False)', "any.tls.verification-disabled"],
  ["j.py", 'payload = jwt.decode(tok, options={"verify_signature": False})', "py.jwt.verify-disabled"],
  [".github/workflows/t.yml", 'on: issues\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ github.event.issue.title }}"', "gha.script-injection"],
  [".github/workflows/u.yml", 'on: issues\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "$TITLE"', null],
  ["k.js", '// db.query(`SELECT * FROM t WHERE a = ${x}`)', null],
  ["l.ts", 'const html = `<p>${escapeHtml(name)}</p>`;', null],
];

test("language rules: positives fire, negatives stay quiet", () => {
  const dir = mkdtempSync(join(tmpdir(), "abl-rules-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [file, code] of CASES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), code + "\n");
  }
  const r = spawnSync(process.execPath, [CLI, "sinks"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const cands = JSON.parse(r.stdout).candidates;
  const problems = [];
  for (const [file, , rule] of CASES) {
    const hits = cands.filter((c) => c.path === file);
    if (rule && !hits.some((c) => c.rule === rule)) problems.push(`${file}: expected ${rule}, got ${hits.map((c) => c.rule).join(",") || "nothing"}`);
    if (!rule && hits.length) problems.push(`${file}: expected nothing, got ${hits.map((c) => c.rule).join(",")}`);
  }
  assert.deepEqual(problems, []);
});
