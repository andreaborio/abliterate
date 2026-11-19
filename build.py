"""Build both distributions from the canonical skills and the TypeScript engine."""
import json
import os
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
packages = root / "packages"
dist = root / "dist"
dist.mkdir(exist_ok=True)

# Engine: one dependency-free bundle for npm (dev dependencies only at build time).
subprocess.run(["npm", "ci", "--prefix", str(root / "engine"), "--ignore-scripts", "--no-audit", "--no-fund"], check=True)
subprocess.run(["node", str(root / "engine" / "build.mjs")], check=True)

for target in (packages / "npm" / "skills", packages / "python" / "src" / "abliterate" / "skills"):
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(root / "skills", target)
# Each package README is its own page. Assets are pinned to the release tag, because relative
# paths do not resolve on npmjs.com or pypi.org.
version = json.loads((packages / "npm" / "package.json").read_text())["version"]
for folder, template in ((packages / "npm", "package-npm.md"), (packages / "python", "package-pypi.md")):
    text = (root / "docs" / template).read_text().replace("{{VERSION}}", version)
    assert "{{VERSION}}" not in text, f"unreplaced placeholder in {template}"
    (folder / "README.md").write_text(text)
    shutil.copyfile(root / "LICENSE", folder / "LICENSE")
os.chmod(packages / "npm" / "cli.cjs", 0o755)
subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(dist)], cwd=packages / "npm", check=True)
subprocess.run(["uv", "build", "--out-dir", str(dist)], cwd=packages / "python", check=True)
