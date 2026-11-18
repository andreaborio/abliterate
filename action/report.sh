#!/usr/bin/env bash
set -euo pipefail

out=${ABL_RUN_DIR:?}
findings="$out/findings.json"
agent_report="$out/agent/findings.json"
render() {
  node "$ABL" report --in "$findings" --sarif "$out/results.sarif" --md "$out/report.md" --fail-on "$FAIL_ON" "$@"
}

# Only the selected agent step in this invocation can supply a reviewed report.
# The checkout is never an input to report selection.
use_draft=true
status=0
if [[ "$AGENT_SUCCEEDED" == true && -f "$agent_report" && ! -L "$agent_report" && -s "$agent_report" ]]; then
  cp "$agent_report" "$findings"
  render || status=$?
  case "$status" in
    0|1) use_draft=false ;;
    2) echo "::warning::The agent report failed validation. Using engine evidence." ;;
    *) exit "$status" ;;
  esac
elif [[ "$AGENT" != none ]]; then
  echo "::warning::No report from a successful agent step. Using engine evidence."
fi

if [[ "$use_draft" == true ]]; then
  cp "$out/draft.json" "$findings"
  render --include-unconfirmed
  status=0
fi

blocking=false
if [[ "$status" == 1 || ( "$BLOCK_CANDIDATES" == true && "$(<"$out/high-candidates.txt")" != 0 ) ]]; then
  blocking=true
fi
cat "$out/report.md" >> "$GITHUB_STEP_SUMMARY"
{
  echo "findings=$findings"
  echo "sarif=$out/results.sarif"
  echo "blocking=$blocking"
} >> "$GITHUB_OUTPUT"
