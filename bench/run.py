#!/usr/bin/env python3
"""Run review arms on paired cases with Claude Code in print mode.

Each run gets a fresh checkout: branch `feature` at the case head, `origin/main` and
`origin/HEAD` at the base. The agent is isolated from the user's configuration
(`--setting-sources ""`, no MCP servers), so neither the user's hooks nor hooks committed
to the reviewed repository run. Tools are read-only: git read commands, and the engine in
the engine arm. Web tools and file writes are denied.

    python3 -I bench/run.py --cases bench/data/pilot.jsonl --arms plain,security-review,skill,skill-engine \
        --model claude-sonnet-5-5 --reps 1 --jobs 4 --run-id pilot-1
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import WORK, git  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
USER_PROMPT = "Review the changes on this branch, compared with origin/main, for security vulnerabilities before I push."
OUTPUT_CONTRACT = """When the review is complete, end your final reply with exactly one fenced ```json block of this form:
{"findings": [{"file": "repo-relative/path", "line": 123, "cwe": "CWE-79", "title": "short title", "status": "confirmed", "severity": "high"}]}
status is "confirmed" for a demonstrated problem or "needs-evidence" for an unresolved suspicion; severity is critical, high, medium or low; cwe may be null.
Include only problems introduced by the changes under review. Use {"findings": []} when there are none."""

READ_TOOLS = ["Read", "Grep", "Glob", "LS", "Task", "Skill"] + [
    f"Bash(git {c}:*)" for c in ("diff", "show", "log", "status", "blame", "rev-parse", "merge-base", "ls-files", "grep", "remote show", "branch", "cat-file", "ls-tree")
] + [
    # Read-only filters agents chain onto git output; without them a whole pipeline is denied.
    f"Bash({c}:*)" for c in ("head", "tail", "wc", "ls", "cat", "grep", "sort", "uniq", "cut", "tr", "nl")
]
STOP = threading.Event()  # set when the account hits a usage limit; queued runs are then skipped
DENIED = ["WebFetch", "WebSearch", "Write", "Edit", "NotebookEdit"]


def plugin_copy(with_engine: bool) -> Path:
    """A frozen copy of the plugin from this checkout; the skill-only arm has no engine on PATH."""
    dest = WORK / "plugins" / ("skill-engine" if with_engine else "skill")
    if dest.exists():
        shutil.rmtree(dest)
    for part in [".claude-plugin", "skills", "agents"] + (["bin"] if with_engine else []):
        src = ROOT / part
        if src.is_dir():
            shutil.copytree(src, dest / part)
    return dest


def arms(model: str) -> dict:
    base = ["--model", model, "--setting-sources", "", "--strict-mcp-config", "--permission-mode", "dontAsk",
            "--append-system-prompt", OUTPUT_CONTRACT, "--disallowedTools", ",".join(DENIED)]
    return {
        "plain": {"prompt": USER_PROMPT, "args": base + ["--allowedTools", ",".join(READ_TOOLS), "--disable-slash-commands"]},
        "security-review": {"prompt": "/security-review", "args": base + ["--allowedTools", ",".join(READ_TOOLS)]},
        "skill": {"prompt": USER_PROMPT, "plugin": False, "args": base + ["--allowedTools", ",".join(READ_TOOLS)]},
        "skill-engine": {"prompt": USER_PROMPT, "plugin": True, "args": base + ["--allowedTools", ",".join(READ_TOOLS + ["Bash(abliterate:*)"])]},
    }


def checkout(case: dict, variant: str, dest: Path) -> None:
    cache = WORK / "repos" / (case["repo"].replace("/", "__") + ".git")
    head = case[variant]
    dest.mkdir(parents=True)
    git(dest, "init", "-q", "-b", "feature")
    (dest / ".git" / "objects" / "info" / "alternates").write_text(str(cache / "objects") + "\n")
    git(dest, "config", "remote.origin.url", f"https://github.com/{case['repo']}.git")
    git(dest, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
    git(dest, "update-ref", "refs/remotes/origin/main", case["base"])
    git(dest, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    git(dest, "update-ref", "refs/heads/feature", head)
    git(dest, "config", "branch.feature.remote", "origin")
    git(dest, "config", "branch.feature.merge", "refs/heads/main")
    git(dest, "read-tree", "-u", "--reset", "HEAD")


def run_one(case: dict, variant: str, arm_name: str, arm: dict, rep: int, out_dir: Path, plugins: dict, timeout: int, budget: float) -> dict:
    key = f"{case['id']}.{variant}.{arm_name}.{rep}"
    raw = out_dir / "raw" / f"{key}.jsonl"
    if raw.exists() and final(raw).get("is_error") is False:
        return {"key": key, "skipped": "done"}
    if STOP.is_set():
        return {"key": key, "skipped": "usage limit"}
    work = WORK / "runs" / out_dir.name / key
    if work.exists():
        shutil.rmtree(work)
    checkout(case, variant, work / "repo")
    cmd = ["claude", "-p", arm["prompt"], "--output-format", "stream-json", "--verbose", "--max-budget-usd", str(budget), *arm["args"]]
    if "plugin" in arm:
        cmd += ["--plugin-dir", str(plugins[arm["plugin"]])]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "CLAUDE_CODE_", "ABLITERATE_"))}
    raw.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with raw.open("w") as fh:
        try:
            p = subprocess.run(cmd, cwd=work / "repo", stdout=fh, stderr=subprocess.PIPE, text=True, timeout=timeout, env=env)
            status = p.returncode
        except subprocess.TimeoutExpired:
            status = "timeout"
    shutil.rmtree(work, ignore_errors=True)
    result = final(raw)
    if result.get("is_error") and "limit" in str(result.get("result", "")).lower():
        STOP.set()
    return {"key": key, "status": status, "seconds": round(time.time() - started), "error": result.get("result") if result.get("is_error") else None}


def final(raw: Path) -> dict:
    """The run's closing `result` event, or {} if it never finished."""
    for line in reversed(raw.read_text().splitlines()):
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "result":
            return ev
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--arms", default="plain,security-review,skill,skill-engine")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--only", help="comma-separated case ids")
    ap.add_argument("--variants", default="pos,neg")
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--budget", type=float, default=5.0, help="max USD per run")
    args = ap.parse_args()

    cases = [json.loads(l) for l in Path(args.cases).read_text().splitlines() if l.strip()]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only.split(",")]
    all_arms = arms(args.model)
    chosen = args.arms.split(",")
    out_dir = ROOT / "bench" / "results" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "config.json").write_text(json.dumps({
        "model": args.model, "arms": chosen, "reps": args.reps, "cases": args.cases,
        "case_ids": [c["id"] for c in cases], "claude": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip(),
        "plugin_commit": git(ROOT, "rev-parse", "HEAD").strip(), "prompt": USER_PROMPT, "contract": OUTPUT_CONTRACT,
    }, indent=2))
    plugins = {}
    if "skill" in chosen:
        plugins[False] = plugin_copy(False)
    if "skill-engine" in chosen:
        plugins[True] = plugin_copy(True)

    jobs = [(c, v, a, r) for r in range(args.reps) for c in cases for v in args.variants.split(",") for a in chosen]
    print(f"{len(jobs)} runs -> {out_dir}", file=sys.stderr)
    with ThreadPoolExecutor(args.jobs) as pool:
        futures = [pool.submit(run_one, c, v, a, all_arms[a], r, out_dir, plugins, args.timeout, args.budget) for c, v, a, r in jobs]
        for f in as_completed(futures):
            try:
                print(json.dumps(f.result()), file=sys.stderr, flush=True)
            except Exception as e:  # keep the other runs going
                print(f"run failed: {e}", file=sys.stderr, flush=True)
    if STOP.is_set():
        print("stopped early: usage limit reached; rerun the same command to resume", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
