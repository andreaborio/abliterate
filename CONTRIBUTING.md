# Contributing

Change the canonical skill in `skills/abliterate-review/SKILL.md`. Edit both thin adapters when changing CLI behavior. Keep generated copies and archives out of Git. When introducing or renaming a topic, update both help texts, the contract test and the catalog in the README.

For a behavioral change, show a small synthetic case, the decision the reviewer made before, and what it should do instead. Include a counterexample where a protective control is already effective. Follow the [verification instructions](verification/README.md); distinguish installed-package checks from actual agent behavior.

For maintainers: align versions, build from a clean checkout and run the release checks in the README. Attach the three generated archives and SHA256SUMS to the matching GitHub tag. npm releases use the verified tarball and require a publisher logged in as andreaborio. PyPI uses a pending or trusted publisher for this repository, workflow `publish-pypi.yml`, environment `pypi`. Dispatch on the release tag after attaching the assets. Inspect the registry metadata before announcing availability.
