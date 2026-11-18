"""Install the actual archives offline and exercise the public CLI contract."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
MANIFEST = json.loads((ROOT / "packages/npm/package.json").read_text())
VERSION = MANIFEST["version"]
PYPROJECT = tomllib.loads((ROOT / "packages/python/pyproject.toml").read_text())["project"]
if (MANIFEST["name"], VERSION, MANIFEST["license"]) != (PYPROJECT["name"], PYPROJECT["version"], PYPROJECT["license"]):
    raise ValueError("Distribution identity mismatch")
canonical = (ROOT / "skills/abliterate-review/SKILL.md").read_bytes()
variants_skill = (ROOT / "skills/abliterate-variants/SKILL.md").read_bytes()
prompts_md = (ROOT / "skills/abliterate-review/reference/prompts.md").read_text(encoding="utf-8")
scope_text = (ROOT / "skills/abliterate-review/reference/review-scope.md").read_text(encoding="utf-8").strip()
license_text = (ROOT / "LICENSE").read_bytes()
npm = DIST / f"abliterate-{VERSION}.tgz"
whl = DIST / f"abliterate-{VERSION}-py3-none-any.whl"
sdist = DIST / f"abliterate-{VERSION}.tar.gz"
topics = ("review", "design", "access", "inputs", "privacy", "state", "delivery", "variants", "fix")
skill_files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "skills").rglob("*") if p.is_file())

def require(ok, message):
    if not ok:
        raise AssertionError(message)

with tarfile.open(npm) as archive:
    expected = {"package/" + n for n in ("LICENSE", "README.md", "cli.cjs", "package.json")} | {"package/" + f for f in skill_files}
    require(set(archive.getnames()) == expected, f"Unexpected npm contents: {sorted(set(archive.getnames()) ^ expected)}")
    require(archive.extractfile("package/LICENSE").read() == license_text, "npm license mismatch")
with zipfile.ZipFile(whl) as archive:
    require(archive.read(f"abliterate-{VERSION}.dist-info/licenses/LICENSE") == license_text, "wheel license mismatch")
with tarfile.open(sdist) as archive:
    prefix = f"abliterate-{VERSION}/"
    require(archive.extractfile(prefix+"src/abliterate/skills/abliterate-review/SKILL.md").read() == canonical, "sdist skill mismatch")

with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    env = dict(os.environ, PIP_NO_INDEX="1", PIP_DISABLE_PIP_VERSION_CHECK="1",
               npm_config_offline="true", npm_config_cache=str(tmp / "npm-cache"))
    def run(args):
        return subprocess.run(args, cwd=tmp, env=env, capture_output=True)
    def setup(args):
        out = run(args)
        require(out.returncode == 0, out.stderr.decode(errors="replace"))
    setup(["npm", "install", "--prefix", str(tmp / "node"), "--ignore-scripts", "--no-audit", "--no-fund", str(npm)])
    setup([sys.executable, "-m", "venv", str(tmp / "py")])
    setup([tmp / "py/bin/python", "-m", "pip", "install", "--no-deps", str(whl)])
    bins = [tmp / "node/node_modules/.bin/abliterate", tmp / "py/bin/abliterate"]
    for args, code in [(["--version"],0), (["skill"],0), (["skill","abliterate-variants"],0), (["prompt"],0),
                       (["review"],0), (["review","--since","feature/team"],0),
                       (["review","--since","--help"],2), (["review","--since","main\nfix"],2), (["review","--since","a..b"],2),
                       (["prompt","unknown"],2), (["prompt","constructor"],2), (["skill","extra"],2), (["skill","--x","1"],2)] + [(["prompt",t],0) for t in topics]:
        a,b = [run([binary,*args]) for binary in bins]
        require(a.returncode == b.returncode == code and (a.stdout,a.stderr) == (b.stdout,b.stderr), f"CLI parity: {args}: {a.returncode}/{b.returncode} {a.stderr!r} {b.stderr!r}")
        if code:
            require(not a.stdout, f"Invalid command emitted a brief: {args}")
        if args == ["skill"]:
            require(a.stdout == canonical, "Installed skill differs from source")
        if args == ["skill","abliterate-variants"]:
            require(a.stdout == variants_skill, "Installed variants skill differs from source")
        if args == ["--version"]:
            require(a.stdout.decode().strip() == VERSION, "Archive version mismatch")
        if args == ["prompt"]:
            require(len(a.stdout.splitlines()) == 1+len(topics), "Catalog should only list topics")
        if code == 0 and (args[0] == "review" or args[0] == "prompt" and len(args) == 2):
            require(scope_text and a.stdout.decode().startswith(scope_text + "\n\n"), f"Missing review scope: {args}")
        if args[:1] == ["prompt"] and len(args)==2 and code==0:
            chosen = prompts_md.split("### "+args[1]+" — ")[1].split("\n",1)[1].split("\n### ")[0].strip()
            first_sentence = chosen.split(". ")[0]
            require(first_sentence and first_sentence in a.stdout.decode(), f"Wrong topic: {args[1]}")
        if args == ["review","--since","feature/team"]:
            require("`feature/team`" in a.stdout.decode(), "Lost base ref")
    # Engine commands exist only in the npm build; the Python package points to npm.
    require(run([bins[0], "sinks", "--help"]).returncode == 0, "npm engine missing")
    py = run([bins[1], "sinks"])
    require(py.returncode == 2 and b"npm" in py.stderr, "Python must point engine commands to npm")
(DIST / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in sorted([npm,whl,sdist])))
print(f"PASS: both installed CLIs, {len(topics)} topics, canonical skill, release metadata and SHA256SUMS")
