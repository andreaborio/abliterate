# abliterate

Review your team's local source changes before a push or merge. `abliterate review --since main` prints a brief for your coding agent. It asks the agent to trace the diff in the checkout, report confirmed regressions and propose tests with synthetic data.

```sh
npx -y abliterate@latest sinks --changed --base main     # candidate vulnerable lines the change introduced
npx -y abliterate@latest deps --changed --base main      # new dependencies: OSV advisories, CISA KEV, EPSS, reachability
npx -y abliterate@latest variants --history --base main  # patterns earlier security fixes removed, still present
npx -y abliterate@latest report --in findings.json --sarif out.sarif
npx -y abliterate@latest hook install                    # pre-push hook, non-blocking by default
npx -y abliterate@latest skill                           # print the abliterate-review skill
```

The commands produce leads. Your agent confirms or disproves them using the bundled `abliterate-review` and `abliterate-variants` skills.

Only `deps` and `variants --from` use the network: they send package names, versions and advisory ids, never source code. `--offline` uses the cache only.

The PyPI package contains the skills and prompts (`skill`, `prompt`, `review`); the engine is npm only. Plugin for Claude Code and Codex, GitHub Action and docs: [andreaborio/abliterate](https://github.com/andreaborio/abliterate). MIT license.
