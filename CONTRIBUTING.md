# Contributing

- **Skills** (`skills/`) are the single source of truth: the plugin, the npm package and the PyPI package ship them unchanged. Keep `SKILL.md` under 500 lines and reference files one level deep.
- **Engine** (`engine/src`, TypeScript): keep it read-only on repositories, dependency-free at runtime, and offline except `deps` and `variants --from`.
  - **New rules:** add a seeded vulnerability *and* a guarded twin to `evals/make_fixtures.py`, or a positive and a negative line to `engine/test/rules.test.mjs`.
  - **Before every change:** run `npm test --prefix engine` and keep zero hits on guarded twins.
- **CLI parity:** `skill`, `prompt` and `review` must produce byte-identical output from npm and PyPI. `verification/check_release.py` checks the installed archives.
- **Behavioral changes to the skill:** add or update a case under `evals/cases/` with graders, and compare with the no-plugin baseline using `claude plugin eval .`.

For maintainers, the release steps:

1. Align the versions in `packages/npm/package.json`, `packages/python/pyproject.toml` and both `plugin.json` files.
2. From a clean checkout, run `python3 build.py && python3 verification/check_release.py`.
3. Attach the archives and `SHA256SUMS` to the matching GitHub tag.
4. npm: the publisher must be logged in as `andreaborio`.
5. PyPI: dispatch `publish-pypi.yml` on the tag.
