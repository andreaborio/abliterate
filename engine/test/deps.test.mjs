import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../../packages/npm/cli.cjs", import.meta.url).pathname;
const MAKE = new URL("../../evals/make_fixtures.py", import.meta.url).pathname;
const REPLAY = new URL("./fixtures/http", import.meta.url).pathname;
let root;

before(() => {
  root = join(mkdtempSync(join(tmpdir(), "abl-deps-")), "fx");
  const r = spawnSync("python3", [MAKE, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

const deps = (cwd, args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, "deps", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("introduced lodash with a called vulnerable function is symbol-used", () => {
  const out = deps(join(root, "deps-reachable"), ["--base", "main"], { ABLITERATE_HTTP_REPLAY: REPLAY });
  assert.equal(out.complete, true, out.notes.join("; "));
  const lodash = out.vulnerable.find((v) => v.package === "lodash");
  assert.ok(lodash && lodash.introduced);
  const adv = lodash.advisories.find((a) => a.id === "GHSA-35jh-r3h4-6jhm");
  assert.ok(adv.aliases.includes("CVE-2021-23337"));
  assert.equal(adv.fixed, "4.17.21");
  assert.equal(adv.reachability.verdict, "symbol-used");
  assert.equal(adv.reachability.symbolUses[0].path, "src/render.js");
  const redos = lodash.advisories.find((a) => a.aliases.includes("CVE-2020-28500"));
  assert.notEqual(redos.reachability.verdict, "symbol-used", "a different advisory must not inherit the template call");
});

test("imported package whose vulnerable function is never called is not symbol-used", () => {
  const out = deps(join(root, "deps-unreachable"), ["--base", "main"], { ABLITERATE_HTTP_REPLAY: REPLAY });
  const adv = out.vulnerable[0].advisories.find((a) => a.id === "GHSA-35jh-r3h4-6jhm");
  assert.equal(adv.reachability.verdict, "imported-symbol-not-seen");
});

test("offline with an empty cache reports incomplete instead of a clean result", () => {
  const out = deps(join(root, "deps-reachable"), ["--base", "main", "--offline"], { ABLITERATE_CACHE_DIR: mkdtempSync(join(tmpdir(), "abl-cache-")) });
  assert.equal(out.complete, false);
  assert.ok(out.notes.some((n) => /Offline/.test(n)));
});

test("lockfile parsers resolve exact versions across ecosystems", () => {
  const dir = mkdtempSync(join(tmpdir(), "abl-lock-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const files = {
    "web/pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n  '@babel/core@7.24.0':\n    resolution: {integrity: x}\n\n  express@4.19.2:\n    resolution: {integrity: y}\n",
    "old/yarn.lock": '# yarn lockfile v1\n\n"minimist@^1.2.0", minimist@^1.2.5:\n  version "1.2.5"\n  resolved "x"\n',
    "py/poetry.lock": '[[package]]\nname = "django"\nversion = "4.2.1"\n\n[[package]]\nname = "requests"\nversion = "2.31.0"\n',
    "py2/requirements.txt": "flask==2.2.0\nrequests>=2\n# comment\n",
    "go/go.mod": "module x\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/net v0.17.0\n\tgithub.com/gin-gonic/gin v1.9.0 // indirect\n)\n",
    "rs/Cargo.lock": '[[package]]\nname = "hyper"\nversion = "0.14.10"\n',
    "rb/Gemfile.lock": "GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.0.4)\n      actionpack (= 7.0.4)\n    nokogiri (1.13.0)\n\nPLATFORMS\n  ruby\n",
    "php/composer.lock": JSON.stringify({ packages: [{ name: "guzzlehttp/guzzle", version: "7.4.0" }] }, null, 2),
  };
  for (const [f, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); }
  const out = deps(dir, ["--inventory"]);
  const got = new Set(out.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`));
  for (const want of ["npm:@babel/core@7.24.0", "npm:express@4.19.2", "npm:minimist@1.2.5", "PyPI:django@4.2.1", "PyPI:requests@2.31.0",
    "PyPI:flask@2.2.0", "Go:golang.org/x/net@v0.17.0", "Go:github.com/gin-gonic/gin@v1.9.0", "crates.io:hyper@0.14.10",
    "RubyGems:rails@7.0.4", "RubyGems:nokogiri@1.13.0", "Packagist:guzzlehttp/guzzle@7.4.0"]) {
    assert.ok(got.has(want), `missing ${want}; got ${[...got].join(", ")}`);
  }
  assert.ok(![...got].some((g) => g.startsWith("RubyGems:actionpack")), "dependency constraints are not resolved versions");
  assert.ok(![...got].some((g) => g.includes("requests@2") && g.startsWith("PyPI:requests@2.31") === false), "ranges are not resolved versions");
});
