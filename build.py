"""Build both distributions from the canonical abliterate-review/SKILL.md."""
import os
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
packages = root / "packages"
dist = root / "dist"
dist.mkdir(exist_ok=True)
for folder in (packages / "npm", packages / "python" / "src" / "abliterate"):
    shutil.copyfile(root / "skills" / "abliterate-review" / "SKILL.md", folder / "SKILL.md")
for folder in (packages / "npm", packages / "python"):
    shutil.copyfile(root / "docs" / "package.md", folder / "README.md")
    shutil.copyfile(root / "LICENSE", folder / "LICENSE")
os.chmod(packages / "npm" / "cli.cjs", 0o755)
subprocess.run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(dist)],
               cwd=packages / "npm", check=True)
subprocess.run(["uv", "build", "--out-dir", str(dist)], cwd=packages / "python", check=True)
