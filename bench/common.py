"""Shared helpers for the benchmark scripts. Standard library only."""
import os
import re
import subprocess
from pathlib import Path

SOURCE_EXT = re.compile(r"\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|go|java|kt|rb|php)$")
TEST_PATH = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs|testdata|fixtures?|e2e|examples?|docs?)/|"
    r"(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|_spec\.rb|Test\.java|Tests?\.kt|_test\.py|test_[^/]*\.py)$"
)
# Files that inflate a diff without being reviewed line by line.
BULK_PATH = re.compile(
    r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|"
    r"uv\.lock|Cargo\.lock|CHANGELOG[^/]*)$|\.min\.(js|css)$|(^|/)(dist|vendor|node_modules)/|\.snap$"
)

WORK = Path(os.environ.get("ABL_BENCH_WORK", Path.home() / ".cache" / "abliterate-bench"))

# Git must not run repository-controlled programs while we build or grade cases.
SAFE_GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_NO_REPLACE_OBJECTS": "1",
}


def is_source(path: str) -> bool:
    return bool(SOURCE_EXT.search(path)) and not TEST_PATH.search(path)


def git(cwd, *args, check=True, input=None) -> str:
    env = {**os.environ, **SAFE_GIT_ENV}
    r = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", *args],
        cwd=cwd, capture_output=True, text=True, env=env, input=input,
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])}: {r.stderr.strip()[:400]}")
    return r.stdout


def numstat(cwd, a: str, b: str) -> list[tuple[int, int, str]]:
    out = []
    for line in git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", a, b).splitlines():
        add, dele, path = line.split("\t", 2)
        out.append((0 if add == "-" else int(add), 0 if dele == "-" else int(dele), path))
    return out


HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def head_ranges(cwd, a: str, b: str, paths=()) -> list[dict]:
    """Head-side line ranges of each hunk between a and b. A pure deletion maps to the line before it."""
    out, current = [], None
    diff = git(cwd, "diff", "--no-ext-diff", "--no-textconv", "-U0", "--no-renames", a, b, "--", *paths)
    for line in diff.splitlines():
        if line.startswith("+++ "):
            current = None if line[4:] == "/dev/null" else line[6:]
        m = HUNK.match(line)
        if m and current:
            start, count = int(m[1]), int(m[2] if m[2] is not None else 1)
            out.append({"file": current, "start": max(1, start), "end": max(1, start + count - 1) if count else max(1, start)})
    return out
