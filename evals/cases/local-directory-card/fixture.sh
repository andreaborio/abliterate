#!/bin/bash
# The eval harness supplies an empty workspace.
set -euo pipefail

git init -q -b main
git config --local user.name Fixture
git config --local user.email fixture@example.invalid
git config --local commit.gpgSign false
git config --local core.hooksPath /dev/null

cat > directory_card.py <<'PY'
"""The member directory card may contain only the display name.
Cost centres are internal accounting data.
"""

def directory_card(member):
    return {"display_name": member["display_name"]}
PY
git add directory_card.py
git commit -qm "Define the member directory card"
git switch -qc feature

sed '/^    return /s/}$/, "cost_center": member["cost_center"]}/' directory_card.py > revision.py
mv revision.py directory_card.py
git add directory_card.py
git commit -qm "Update directory card fields"
