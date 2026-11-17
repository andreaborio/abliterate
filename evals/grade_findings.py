"""Grade an agent's findings.json against the fixture expectations.

Usage: python3 evals/grade_findings.py EXPECTED_JSON FIXTURE_NAME FINDINGS_JSON
Prints one line per check and exits 1 if any check fails. Lines match within 2.
"""
import json
import sys

LINE_TOLERANCE = 2  # agents may anchor on the call or the statement around it


def main():
    expected_path, name, findings_path = sys.argv[1:4]
    fixture = next(f for f in json.load(open(expected_path))["fixtures"] if f["name"] == name)
    try:
        report = json.load(open(findings_path))
        findings = report.get("findings", [])
    except (OSError, ValueError) as err:
        print(f"FAIL findings.json unreadable: {err}")
        return 1
    checks = []

    def near(f, e):
        loc = f.get("location", {})
        same_file = loc.get("path") == e["path"]
        traced = any(t.get("path") == e["path"] and abs(t.get("startLine", 0) - e["line"]) <= LINE_TOLERANCE for t in f.get("trace", []))
        return same_file and (abs(loc.get("startLine", 0) - e["line"]) <= LINE_TOLERANCE or traced) or traced

    for e in fixture["expect"]:
        if e["kind"] == "vuln" and e["path"] != "package-lock.json":
            hits = [f for f in findings if near(f, e)]
            want = "confirmed" if e["introduced"] else "pre-existing"
            ok = any(f.get("status") == want for f in hits)
            checks.append((ok, f"{e['cwe']} at {e['path']}:{e['line']} reported as {want}" + ("" if ok else f" (got {[f.get('status') for f in hits] or 'nothing'})")))
        if e["kind"] == "safe":
            bad = [f for f in findings if f.get("status") == "confirmed" and f.get("location", {}).get("path") == e["path"]
                   and abs(f.get("location", {}).get("startLine", 0) - e["line"]) <= LINE_TOLERANCE]
            checks.append((not bad, f"guarded {e['path']}:{e['line']} not confirmed"))
    if name == "deps-unreachable":
        bad = [f for f in findings if f.get("status") == "confirmed" and (f.get("source") == "deps" or "lodash" in json.dumps(f).lower())]
        checks.append((not bad, "unreachable lodash advisories not confirmed"))
    for ok, msg in checks:
        print(("PASS " if ok else "FAIL ") + msg)
    return 0 if all(ok for ok, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
