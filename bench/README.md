# Benchmark

Does abliterate catch more real regressions, with fewer false alarms, than the same model without it? This directory measures that on real vulnerabilities published after the models' training cutoff.

## Cases: paired regressions from real fixes

Each case comes from a GitHub reviewed advisory whose fix is a single public commit `F` that changes a few lines of application source.

| Ref | Contents |
| --- | --- |
| `base` | `F`: the fix is in place |
| `neg` | `N`: the real commits that followed `F` on the default branch, 150 to 3000 changed lines (the noise) |
| `pos` | `N` plus one commit that reverts the fix's source hunks |

The two heads share the same noise.
- On `pos`, the reviewer must catch the reintroduced vulnerability. The ground truth is the exact head-side lines of the revert.
- On `neg`, every confirmed finding counts as a false alarm.

**Why this design:**
- Advisories published after the cutoff mean the model cannot have memorised the fix.
- The ground truth location is exact, with no SZZ heuristics.
- False alarms are measured in the same conditions as detection, not on a separate easy set.

**Known biases:**
- **The regression is a revert.** Real introducing commits look different. An introducing-commit track via SZZ is the next step.
- **The fix commit is in the base history.** A reviewer who reads `git log` or `git blame` can notice the revert. Real regressions have the same property, and `variants --history` relies on it.
- **The revert has a neutral message** (`Update <file>`) and a synthetic author. The negative twin has no such extra commit.
- **Not every confirmed finding on `neg` is necessarily false.** The noise may contain real bugs. A sample of false alarms is read by hand before results are published.
- **The advisory pool is mostly npm and PyPI.**

## Arms

All arms run `claude -p` with the same model, the same user prompt and the same output contract, appended to the system prompt: a final `findings` JSON block.

| Arm | What runs |
| --- | --- |
| `plain` | No plugin, skills disabled |
| `security-review` | The built-in `/security-review` command, which compares against `origin/HEAD` |
| `skill` | The abliterate plugin without its engine |
| `skill-engine` | The abliterate plugin with `bin/abliterate` on PATH and `Bash(abliterate:*)` allowed |

**Isolation and permissions:**
- `--setting-sources ""` and `--strict-mcp-config` keep the user's settings and hooks out, along with any `.claude/` hooks committed to the reviewed repository. This was checked with a hook that writes a marker file.
- Tools are read-only: `Read`, `Grep`, `Glob`, `Task`, `Skill` and git read commands. `Write`, `Edit`, `WebFetch` and `WebSearch` are denied.
- Each run gets a fresh checkout. Repository objects are shared from a cached bare clone through alternates.

## Running

```sh
python3 -I bench/mine.py --since 2026-07-01 --out bench/data/candidates.jsonl
python3 -I bench/build_cases.py --candidates bench/data/candidates.jsonl --out bench/data/cases.jsonl --limit 50
python3 -I bench/run.py --cases bench/data/cases.jsonl --model claude-sonnet-5-5 --reps 3 --jobs 4 --run-id <id>
python3 -I bench/grade.py --run bench/results/<id> --cases bench/data/cases.jsonl
```

**Where things go:**
- Clones and checkouts go to `~/.cache/abliterate-bench`; set `ABL_BENCH_WORK` to change it.
- Raw transcripts go to `bench/results/<id>/raw/` and are not committed.
- `summary.md` and `scores.json` are committed.

**Prerequisites:** `mine.py` needs an authenticated `gh`, and `run.py` needs `claude` logged in. Runs count against your usage.

## Metrics

| Metric | Meaning |
| --- | --- |
| caught (confirmed) | `pos` runs with a confirmed finding within ±8 lines of a truth hunk |
| caught (any status) | The same, counting `needs-evidence` |
| false alarm on clean twin | `neg` runs with at least one confirmed finding |
| pair solved | Caught on `pos` and silent on `neg`, in the same repetition |
| $/run, time | From the `result` event of `claude -p` |
| skill invoked, engine used | From the transcript's tool calls |

## Pilot results (2026-11-19)

The pilot ran 12 pairs (`data/pilot2.jsonl`) with Sonnet 5.5 and 1 repetition. Each arm saw squashed heads with 200 to 1300 lines of real noise. `pilot-sonnet-2` measures the published 0.2.1 skill. `pilot-sonnet-2-fix` measures the 0.2.2 skill; its `config.json` records the 0.2.1 commit, because the skill change was still uncommitted when it ran.

| Arm | Caught (confirmed) | False alarm on clean twin | Pair solved |
| --- | --- | --- | --- |
| plain | 11/12 | 1/12 | 10/12 |
| security-review | 11/12 | 1/12 | 10/12 |
| skill, 0.2.1 | 3/12 | 1/12 | 2/12 |
| skill, 0.2.2 | 10/12 | 2/12 | 9/12 |
| skill-engine, 0.2.1 | 11/12 | 1/12 | 10/12 |
| skill-engine, 0.2.2 | 12/12 | 2/12 | 10/12 |

**Why 0.2.1 failed without the engine:**
- The skill joined `abliterate scope` and `git` commands into one shell line.
- With the engine not allowed, the whole line was denied.
- The agent then concluded that Bash was unavailable and stopped.

0.2.2 runs one command per call and keeps reviewing after a denial.

**What this pilot cannot show:**
- **No real separation yet:** these cases are too easy to separate the arms, since the baseline already catches 11 of 12. One repetition on 12 pairs cannot separate differences of one or two cases.
- **Next steps:**
  - larger diffs;
  - an introducing-commit track;
  - 50 pairs with 3 repetitions.
