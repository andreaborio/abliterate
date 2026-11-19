#!/bin/bash
# Builds the supabase-rows-not-columns fixture repository in the empty workspace (synthetic code, no network).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
python3 "$here/../../make_fixtures.py" "$tmp/fx" > /dev/null
cp -R "$tmp/fx/supabase-rows-not-columns/." .
