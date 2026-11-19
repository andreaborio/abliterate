#!/usr/bin/env python3
"""Turn mined candidates into paired regression cases.

For an advisory fixed by commit F on the default branch:

    base = F                       the fix is in place
    neg  = N                       real commits that followed F (the noise), no vulnerability
    pos  = N + revert(F, source)   the same noise plus the fix's source hunks reverted

The pair shares its noise, so a finding on `neg` is a false alarm under the same conditions
in which `pos` must be caught. Ground truth is the exact head-side lines of the revert.

    python3 -I bench/build_cases.py --candidates bench/data/candidates.jsonl --out bench/data/cases.jsonl --limit 50
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BULK_PATH, WORK, git, head_ranges, is_source, numstat  # noqa: E402

AUTHOR = {"GIT_AUTHOR_NAME": "Bench Author", "GIT_AUTHOR_EMAIL": "author@example.invalid",
          "GIT_COMMITTER_NAME": "Bench Author", "GIT_COMMITTER_EMAIL": "author@example.invalid"}


def cache_repo(repo: str, branch: str) -> Path:
    path = WORK / "repos" / (repo.replace("/", "__") + ".git")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["git", "clone", "-q", "--bare", "--single-branch", "--no-tags", "--branch", branch,
                            f"https://github.com/{repo}.git", str(path)], capture_output=True, text=True,
                           env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        if r.returncode != 0:
            raise RuntimeError(f"clone {repo}: {r.stderr.strip()[:300]}")
    return path


def noise_lines(cache: Path, a: str, b: str) -> int:
    return sum(add + dele for add, dele, path in numstat(cache, a, b) if not BULK_PATH.search(path))


def pick_noise(cache: Path, fix: str, branch: str, lo: int, hi: int, max_commits: int):
    chain = git(cache, "rev-list", "--first-parent", "--reverse", f"{fix}..refs/heads/{branch}").split()
    previous = None
    for i, c in enumerate(chain[:max_commits]):
        # With F merged from a side branch, the first-parent chain also lists main-line commits that predate the merge.
        if subprocess.run(["git", "merge-base", "--is-ancestor", fix, c], cwd=cache).returncode != 0:
            continue
        n = noise_lines(cache, fix, c)
        if n >= lo:
            if n <= hi:
                return c, i + 1, n
            return previous if previous and previous[2] >= lo // 3 else None
        previous = (c, i + 1, n)
    return previous if previous and previous[2] >= lo // 3 else None


def revert_commit(cache: Path, fix: str, files: list[str], onto: str, date: str) -> str | None:
    patch = git(cache, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", f"{fix}^", fix, "--", *files)
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index"), **AUTHOR,
               "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
        def g(*args, input=None):
            r = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cache, env=env,
                               capture_output=True, text=True, input=input)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.strip()[:300])
            return r.stdout
        g("read-tree", onto)
        try:
            g("apply", "--cached", "-R", input=patch)
        except RuntimeError:
            return None
        tree = g("write-tree").strip()
        name = Path(files[0]).name
        return g("commit-tree", tree, "-p", onto, "-m", f"Update {name}").strip()


def squash(cache: Path, head: str, base: str, date: str) -> str:
    """One commit with head's tree on top of base, identical in shape for both twins."""
    env = {**os.environ, **AUTHOR, "GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date}
    r = subprocess.run(["git", "commit-tree", f"{head}^{{tree}}", "-p", base, "-m", "Pending changes"],
                       cwd=cache, env=env, capture_output=True, text=True, check=True)
    return r.stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--ids", help="comma-separated GHSA ids to build, in this order")
    ap.add_argument("--noise-min", type=int, default=150)
    ap.add_argument("--noise-max", type=int, default=3000)
    ap.add_argument("--noise-commits", type=int, default=60)
    ap.add_argument("--no-squash", dest="squash", action="store_false",
                    help="keep the real noise commits and a separate revert commit (the revert is then easy to spot)")
    args = ap.parse_args()

    candidates = [json.loads(l) for l in Path(args.candidates).read_text().splitlines() if l.strip()]
    if args.ids:
        want = args.ids.split(",")
        candidates = sorted((c for c in candidates if c["ghsa"] in want), key=lambda c: want.index(c["ghsa"]))
    out = Path(args.out)
    done = {json.loads(l)["id"] for l in out.read_text().splitlines()} if out.exists() else set()
    built = len(done)
    with out.open("a") as fh:
        for c in candidates:
            if built >= args.limit:
                break
            cid = c["ghsa"].lower()
            if cid in done:
                continue
            why = None
            try:
                cache = cache_repo(c["repo"], c["default_branch"])
                fix = c["fix"]
                if git(cache, "cat-file", "-t", fix, check=False).strip() != "commit":
                    why = "fix not on default branch clone"
                elif subprocess.run(["git", "merge-base", "--is-ancestor", fix, f"refs/heads/{c['default_branch']}"], cwd=cache).returncode != 0:
                    why = "fix not on default branch"
                else:
                    picked = pick_noise(cache, fix, c["default_branch"], args.noise_min, args.noise_max, args.noise_commits)
                    if not picked:
                        why = "no suitable noise window after the fix"
                    else:
                        neg, ncommits, nlines = picked
                        files = [f for f in c["source_files"] if is_source(f)]
                        date = git(cache, "show", "-s", "--format=%cI", neg).strip()
                        pos = revert_commit(cache, fix, files, neg, date)
                        if not pos:
                            why = "revert conflicts with the noise"
                        else:
                            truth = head_ranges(cache, neg, pos)
                            if not truth:
                                why = "revert is empty on the noise head"
                            elif args.squash:
                                neg, pos = squash(cache, neg, fix, date), squash(cache, pos, fix, date)
            except RuntimeError as e:
                why = str(e)
            if why:
                print(f"skip {cid} ({c['repo']}): {why}", file=sys.stderr)
                continue
            for name, sha in (("base", fix), ("neg", neg), ("pos", pos)):
                git(cache, "update-ref", f"refs/bench/{cid}/{name}", sha)
            spec = {
                "id": cid, "ghsa": c["ghsa"], "cve": c.get("cve"), "repo": c["repo"], "ecosystem": c["ecosystem"],
                "cwes": c["cwes"], "severity": c["severity"], "summary": c["summary"],
                "base": fix, "neg": neg, "pos": pos, "squashed": args.squash, "noise_commits": ncommits, "noise_lines": nlines,
                "truth": truth,
            }
            spec["digest"] = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
            fh.write(json.dumps(spec) + "\n")
            fh.flush()
            built += 1
            print(f"built {cid} {c['repo']}: noise {ncommits} commits / {nlines} lines, truth {len(truth)} hunks", file=sys.stderr)
    print(f"{built} cases in {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
