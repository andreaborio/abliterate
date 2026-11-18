<picture>
  <source media="(max-width: 600px)" srcset="docs/assets/cover-compact.svg">
  <img src="docs/assets/cover.svg" width="960" alt="abliterate — security review of source code before you push and on every pull request">
</picture>

# Catch the vulnerability before the push.

abliterate helps a team check its own source changes before a push or merge. **Which product rule does this change break, and which test would catch it?** The reviewer reads the supplied checkout, traces the changed path and reports what the evidence supports. An application URL can identify the route to look up in code. The running application stays outside the review.

It has three parts that work together:

- **A skill** for Claude Code and Codex. It traces attacker-controlled data from the entry point to the sink, finds the guard on that exact path, and tries to disprove every suspicion before reporting it.
- **An engine**, the `abliterate` CLI. It collects evidence the agent can trust: which states changed, attack surface, candidate sinks, vulnerable dependencies with reachability, and variants of past fixes.
- **A git integration**: a pre-push hook and a GitHub Action that report every pull request to code scanning and in one PR comment.

There is no abliterate model or service. The reasoning runs in your agent, with its permissions. The engine runs locally and is read-only.

## Install

**Claude Code** (plugin: both skills and a read-only reviewer agent)

```text
/plugin marketplace add andreaborio/abliterate
/plugin install abliterate@abliterate
```

**Codex**

```sh
codex plugin marketplace add andreaborio/abliterate
```

**Any agent with Agent Skills**

```sh
npx skills add andreaborio/abliterate --skill abliterate-review --skill abliterate-variants
```

**The engine** needs no install: `npx -y abliterate@latest --help`.

## Try a review

> Review the changes our team would push against main. Use the local diff, callers and tests to check our product's security rules. Report confirmed regressions and suggest a test with synthetic data for each. Leave files unchanged.

The skill runs the engine, traces each lead, and reports only what it could demonstrate. Each confirmed finding comes with:
- the `file:line`;
- the actor;
- the broken rule;
- the effect;
- a fix;
- the test that fails before the fix.

Suspicions it could not settle are listed separately, with the one fact that would decide them.

Other requests:

- **Check whether a fix was complete:** "Is CVE-2021-23337 reachable here?" or "Did the XSS fix in a1b2c3 miss similar code?"
- **Design mode:** "Design the access rules for a shared invoice before I write the endpoint."
- **Fix mode:** "Fix the confirmed IDOR and add the regression test."

## The engine

```sh
npx -y abliterate@latest <command>
```

| Command | Output |
| --- | --- |
| `scope --base main` | Verified review states: commits since the merge-base, staged, unstaged, untracked |
| `surface --changed` | Routes, server actions, jobs, webhooks and CI triggers in changed files, with the auth names on each |
| `sinks --changed` | Candidate vulnerable lines by CWE, marked with the snapshot that introduced them |
| `deps --changed` | Dependencies the change added or bumped. Each comes with its OSV advisories, the CISA KEV flag, EPSS, and whether the vulnerable function is actually called |
| `variants --history` | Patterns that past security fixes in the repo removed, still present elsewhere |
| `variants --from CVE-…` | The same, seeded from an advisory, a fixing commit or a GitHub commit URL |
| `report --in findings.json` | Validates the agent's findings and writes SARIF 2.1.0 and markdown |
| `hook install` | A pre-push hook with the fast checks; non-blocking unless `ABLITERATE_BLOCK=1` |

Candidates are leads, not findings. The rules recognise common guards (parameterised queries, allowlists, `safe_join`, sanitisers) and stay quiet when one sits on the same path. Secrets are never printed.

### What leaves your machine

- **`deps`** sends package names and versions to `api.osv.dev`, and CVE ids to `api.first.org` (EPSS). It downloads the CISA KEV feed.
- **`variants --from`** fetches a public advisory or GitHub patch.
- **Nothing else** contacts the network. Source code, file paths and repository names are never sent.
- **Offline use:** `--offline` uses only the local cache (`~/.cache/abliterate`), and `deps --inventory` lists packages with no network at all.

## GitHub Action

```yaml
name: abliterate
on: pull_request
permissions:
  contents: read
  pull-requests: write     # the PR comment
  security-events: write   # code scanning upload
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: andreaborio/abliterate@v0.2.0
        with:
          agent: claude                       # none | claude | codex
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on: high
```

**What the job does:**
- Engine evidence is collected on every PR, with no key.
- With an `agent`, Claude Code or Codex reviews the PR read-only, following the skill, and writes findings that the engine validates.
- Results go to code scanning as SARIF, and one PR comment is created and then updated.

**When the check fails:**
- `fail-on` fails the check only on **confirmed** findings introduced by the PR.
- Without an agent nothing is confirmed. Engine candidates appear as notes, and `block-on-candidates: true` turns high-confidence candidates into a failing check.

**Safety:**
- The workflow uses `pull_request`, never `pull_request_target`.
- The agent step is skipped for forks, which have no secrets.
- The agent may not run the PR's code.

## How it is verified

- **`engine/` tests** (`npm test`) run every rule against 14 synthetic repositories (`evals/make_fixtures.py`). Each repository seeds one vulnerability next to a guarded twin that must not be flagged. The tests also check that:
  - SARIF validates against the official OASIS schema;
  - OSV, KEV and EPSS lookups replay recorded responses.
- **Release check** (`python3 build.py && python3 verification/check_release.py`): installs the built npm and PyPI packages and checks that they behave identically.
- **Agent evals** (`claude plugin eval .`): run the plugin on cases under `evals/cases/`, against a no-plugin baseline.

Engine results are deterministic. Agent results are measured, not guaranteed.

## Development

The skills in `skills/` are the source of truth, shared by the plugin, the npm package and the PyPI package. The engine is TypeScript in `engine/src`, bundled into one dependency-free file. See [CONTRIBUTING](CONTRIBUTING.md) and the [security policy](SECURITY.md).

MIT license.
