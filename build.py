"""Build both distributions from the canonical skills and the TypeScript engine."""
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
for folder in (packages / "npm", packages / "python"):
    shutil.copyfile(root / "docs" / "package.md", folder / "README.md")
    shutil.copyfile(root / "LICENSE", folder / "LICENSE")
os.chmod(packages / "npm" / "cli.cjs", 0o755)
subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(dist)], cwd=packages / "npm", check=True)
subprocess.run(["uv", "build", "--out-dir", str(dist)], cwd=packages / "python", check=True)
