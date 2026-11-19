#!/usr/bin/env python3
"""Mine GitHub reviewed advisories published after a cutoff into benchmark candidates.

A candidate is an advisory whose fix is one public GitHub commit that changes a few
lines of application source. Only public advisory metadata and public commit diffs
are fetched, through the authenticated `gh` CLI.

    python3 -I bench/mine.py --since 2026-07-01 --out bench/data/candidates.jsonl
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import SOURCE_EXT, TEST_PATH  # noqa: E402

ECOSYSTEMS = ["npm", "pip", "go", "maven", "rubygems", "composer"]
# Classes a source review can settle from code. Resource exhaustion and memory safety are left out.
EXCLUDED_CWES = {
    "CWE-400", "CWE-770", "CWE-1333", "CWE-674", "CWE-834", "CWE-407", "CWE-1050", "CWE-405", "CWE-409",
    "CWE-119", "CWE-120", "CWE-125", "CWE-787", "CWE-416", "CWE-190", "CWE-476", "CWE-401", "CWE-835",
}
COMMIT_URL = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+)/commit/([0-9a-f]{7,40})$")


def gh(path: str, params: dict | None = None, paginate: bool = False):
    cmd = ["gh", "api", "-X", "GET", path]
    for k, v in (params or {}).items():
        cmd += ["-f", f"{k}={v}"]
    if paginate:
        cmd += ["--paginate", "--slurp"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"gh api {path}: {r.stderr.strip()[:300]}")
    data = json.loads(r.stdout)
    if paginate:
        return [item for page in data for item in page]
    return data


def advisories(since: str, ecosystem: str):
    return gh("/advisories", {"published": f">{since}", "ecosystem": ecosystem, "type": "reviewed", "per_page": "100"}, paginate=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True, help="publication cutoff, YYYY-MM-DD (after the models' training cutoff)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-source-lines", type=int, default=120)
    ap.add_argument("--max-source-files", type=int, default=4)
    ap.add_argument("--max-repo-kb", type=int, default=150_000)
    ap.add_argument("--per-repo", type=int, default=2)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    seen_commits, per_repo, repo_size = set(), {}, {}
    stats = {"advisories": 0, "cwe": 0, "no_single_commit": 0, "commit": 0, "shape": 0, "repo": 0, "kept": 0}
    with out.open("w") as fh:
        for eco in ECOSYSTEMS:
            items = advisories(args.since, eco)
            print(f"{eco}: {len(items)} advisories", file=sys.stderr)
            for a in items:
                stats["advisories"] += 1
                cwes = [c["cwe_id"] for c in a.get("cwes") or []]
                if not cwes or any(c in EXCLUDED_CWES for c in cwes):
                    stats["cwe"] += 1
                    continue
                src = (a.get("source_code_location") or "").rstrip("/").lower()
                commits = set()
                for ref in a.get("references") or []:
                    m = COMMIT_URL.match(ref)
                    if m and f"https://github.com/{m[1]}/{m[2]}".lower() == src:
                        commits.add((m[1], m[2], m[3]))
                if len(commits) != 1:
                    stats["no_single_commit"] += 1
                    continue
                owner, repo, sha = commits.pop()
                slug = f"{owner}/{repo}".lower()
                if per_repo.get(slug, 0) >= args.per_repo:
                    continue
                try:
                    c = gh(f"/repos/{owner}/{repo}/commits/{sha}")
                except RuntimeError:
                    stats["commit"] += 1
                    continue
                if c["sha"] in seen_commits or len(c.get("parents") or []) != 1:
                    stats["commit"] += 1
                    continue
                files = c.get("files") or []
                source = [f for f in files if SOURCE_EXT.search(f["filename"]) and not TEST_PATH.search(f["filename"])]
                lines = sum(f["additions"] + f["deletions"] for f in source)
                if not source or len(source) > args.max_source_files or lines > args.max_source_lines or any(f["status"] not in ("modified",) for f in source):
                    stats["shape"] += 1
                    continue
                if slug not in repo_size:
                    try:
                        info = gh(f"/repos/{owner}/{repo}")
                        repo_size[slug] = (info["size"], info["default_branch"], info.get("archived", False))
                    except RuntimeError:
                        repo_size[slug] = (10**9, "", True)
                size, default_branch, archived = repo_size[slug]
                if size > args.max_repo_kb or archived:
                    stats["repo"] += 1
                    continue
                seen_commits.add(c["sha"])
                per_repo[slug] = per_repo.get(slug, 0) + 1
                stats["kept"] += 1
                fh.write(json.dumps({
                    "ghsa": a["ghsa_id"], "cve": a.get("cve_id"), "published": a["published_at"],
                    "severity": a.get("severity"), "cwes": cwes, "summary": a.get("summary"),
                    "ecosystem": eco, "repo": f"{owner}/{repo}", "default_branch": default_branch,
                    "fix": c["sha"], "source_files": [f["filename"] for f in source], "source_lines": lines,
                }) + "\n")
                fh.flush()
    print(json.dumps(stats), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
