#!/usr/bin/env python3
"""Grade a benchmark run deterministically and write summary.md and scores.json.

A finding matches the ground truth when its file is a truth file and its line falls within
TOLERANCE lines of a truth hunk. On `pos` the question is whether the regression was caught;
on `neg`, which carries the same noise without the regression, every confirmed finding is a
false alarm under the benchmark's label (introduced by the changes under review).

    python3 -I bench/grade.py --run bench/results/pilot-1 --cases bench/data/pilot.jsonl
"""
import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

TOLERANCE = 8
JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.S)


def parse_stream(path: Path) -> dict:
    result, tools = None, []
    for line in path.read_text().splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "result":
            result = ev
        elif ev.get("type") == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    tools.append({"name": block["name"], "input": block.get("input", {})})
    return {"result": result, "tools": tools}


def findings_of(text: str):
    blocks = JSON_BLOCK.findall(text or "")
    for raw in reversed(blocks):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and isinstance(data.get("findings"), list):
            return [f for f in data["findings"] if isinstance(f, dict)]
    return None


def norm(path) -> str:
    p = str(path or "").strip().lstrip("./")
    return re.sub(r"^.*?/repo/", "", p)


def matches(f: dict, truth: list[dict]) -> bool:
    file, line = norm(f.get("file")), f.get("line")
    if not isinstance(line, int):
        try:
            line = int(str(line).split("-")[0])
        except ValueError:
            return False
    return any((file == t["file"] or file.endswith("/" + t["file"]) or t["file"].endswith("/" + file))
               and t["start"] - TOLERANCE <= line <= t["end"] + TOLERANCE for t in truth)


def grade_run(raw: Path, case: dict) -> dict:
    s = parse_stream(raw)
    res = s["result"] or {}
    findings = findings_of(res.get("result", ""))
    confirmed = [f for f in findings or [] if f.get("status") == "confirmed"]
    serious = [f for f in confirmed if str(f.get("severity", "")).lower() in ("critical", "high", "medium")]
    skill = any(t["name"] == "Skill" and "abliterate" in json.dumps(t["input"]) for t in s["tools"])
    engine = sorted({m for t in s["tools"] if t["name"] == "Bash"
                     for m in re.findall(r"(?:^|[;&|]\s*)abliterate\s+(\w+)", t["input"].get("command", ""))})
    return {
        "ok": bool(res) and not res.get("is_error"), "parse_error": findings is None,
        "findings": findings or [], "confirmed": len(confirmed), "serious": len(serious),
        "hit_confirmed": any(matches(f, case["truth"]) for f in confirmed),
        "hit_any": any(matches(f, case["truth"]) for f in findings or []),
        "extra_confirmed": sum(not matches(f, case["truth"]) for f in confirmed),
        "cost": res.get("total_cost_usd") or 0.0, "seconds": (res.get("duration_ms") or 0) / 1000,
        "turns": res.get("num_turns") or 0, "skill": skill, "engine": engine,
    }


def pct(xs) -> str:
    xs = list(xs)
    return f"{100 * sum(xs) / len(xs):.0f}% ({sum(xs)}/{len(xs)})" if xs else "–"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--cases", required=True)
    args = ap.parse_args()
    run = Path(args.run)
    cases = {c["id"]: c for c in (json.loads(l) for l in Path(args.cases).read_text().splitlines() if l.strip())}

    graded = {}
    for raw in sorted((run / "raw").glob("*.jsonl")):
        cid, variant, arm, rep = raw.stem.split(".")
        if cid in cases:
            graded[(cid, variant, arm, int(rep))] = grade_run(raw, cases[cid])

    arms = sorted({k[2] for k in graded}, key=["plain", "security-review", "skill", "skill-engine"].index)
    rows, scores = [], {}
    for arm in arms:
        pos = [g for (c, v, a, r), g in graded.items() if a == arm and v == "pos"]
        neg = [g for (c, v, a, r), g in graded.items() if a == arm and v == "neg"]
        pairs = [(graded[(c, "pos", arm, r)], graded[(c, "neg", arm, r)]) for (c, v, a, r) in graded
                 if a == arm and v == "pos" and (c, "neg", arm, r) in graded]
        allr = pos + neg
        scores[arm] = {
            "caught_confirmed": sum(g["hit_confirmed"] for g in pos), "caught_any": sum(g["hit_any"] for g in pos), "pos": len(pos),
            "neg_false_alarm": sum(g["confirmed"] > 0 for g in neg), "neg": len(neg),
            "neg_false_alarm_medium_plus": sum(g["serious"] > 0 for g in neg),
            "neg_confirmed_mean": statistics.mean(g["confirmed"] for g in neg) if neg else None,
            "pair_ok": sum(p["hit_confirmed"] and n["confirmed"] == 0 for p, n in pairs), "pairs": len(pairs),
            "cost_total": sum(g["cost"] for g in allr), "cost_mean": statistics.mean(g["cost"] for g in allr) if allr else None,
            "seconds_median": statistics.median(g["seconds"] for g in allr) if allr else None,
            "skill_invoked": sum(g["skill"] for g in allr), "engine_used": sum(bool(g["engine"]) for g in allr),
            "parse_errors": sum(g["parse_error"] for g in allr), "failed": sum(not g["ok"] for g in allr), "runs": len(allr),
        }
        s = scores[arm]
        rows.append(f"| {arm} | {pct(g['hit_confirmed'] for g in pos)} | {pct(g['hit_any'] for g in pos)} | "
                    f"{pct(g['confirmed'] > 0 for g in neg)} | {pct(g['serious'] > 0 for g in neg)} | {'–' if s['neg_confirmed_mean'] is None else format(s['neg_confirmed_mean'], '.2f')} | "
                    f"{pct(p['hit_confirmed'] and n['confirmed'] == 0 for p, n in pairs)} | "
                    f"${s['cost_mean']:.2f} | {s['seconds_median']:.0f}s | {pct(g['skill'] for g in allr)} | {pct(bool(g['engine']) for g in allr)} | "
                    f"{s['parse_errors'] + s['failed']} |")

    per_case = ["| case | CWE | " + " | ".join(arms) + " |", "|---|---|" + "---|" * len(arms)]
    for cid in sorted({k[0] for k in graded}):
        cells = []
        for arm in arms:
            reps = sorted({r for (c, v, a, r) in graded if c == cid and a == arm})
            cell = []
            for r in reps:
                p, n = graded.get((cid, "pos", arm, r)), graded.get((cid, "neg", arm, r))
                cell.append(("✓" if p and p["hit_confirmed"] else "~" if p and p["hit_any"] else "✗" if p else "·")
                            + ("" if not n else "" if n["confirmed"] == 0 else f" +{n['confirmed']}fa"))
            cells.append(" / ".join(cell))
        per_case.append(f"| {cid} ({cases[cid]['repo']}) | {cases[cid]['cwes'][0]} | " + " | ".join(cells) + " |")

    config = json.loads((run / "config.json").read_text()) if (run / "config.json").exists() else {}
    md = [f"# Run {run.name}", "", f"Model `{config.get('model')}`, Claude Code {config.get('claude')}, plugin {str(config.get('plugin_commit'))[:7]}, "
          f"{len({k[0] for k in graded})} cases, tolerance ±{TOLERANCE} lines.", "",
          "| arm | caught (confirmed) | caught (any status) | false alarm on clean twin | of which ≥ medium | confirmed per clean twin | pair solved | $/run | median time | skill invoked | engine used | errors |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|", *rows, "",
          "Per case: ✓ caught as confirmed, ~ caught only as needs-evidence, ✗ missed; `+Nfa` = N confirmed findings on the clean twin.", "", *per_case, ""]
    (run / "summary.md").write_text("\n".join(md))
    (run / "scores.json").write_text(json.dumps({"scores": scores, "runs": {".".join(map(str, k)): v for k, v in graded.items()}}, indent=1))
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
