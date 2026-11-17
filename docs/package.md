# abliterate

Evidence for a security review of source code, for coding agents and CI. Read-only on your repository.

```sh
npx -y abliterate@0.2.0 sinks --changed --base main     # candidate vulnerable lines the change introduced
npx -y abliterate@0.2.0 deps --changed --base main      # new dependencies: OSV advisories, CISA KEV, EPSS, reachability
npx -y abliterate@0.2.0 variants --history --base main  # patterns earlier security fixes removed, still present
npx -y abliterate@0.2.0 report --in findings.json --sarif out.sarif
npx -y abliterate@0.2.0 hook install                    # pre-push hook, non-blocking by default
npx -y abliterate@0.2.0 skill                           # print the abliterate-review skill
```

The commands produce leads. Your agent confirms or disproves them using the bundled `abliterate-review` and `abliterate-variants` skills.

Only `deps` and `variants --from` use the network: they send package names, versions and advisory ids, never source code. `--offline` uses the cache only.

The PyPI package contains the skills and prompts (`skill`, `prompt`, `review`); the engine is npm only. Plugin for Claude Code and Codex, GitHub Action and docs: [andreaborio/abliterate](https://github.com/andreaborio/abliterate). MIT license.
