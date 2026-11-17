import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding, Report, Severity } from "../findings";
import type { Candidate } from "../scan";
import { allowFlags, EXIT, str, UsageError, type Flags } from "../util";

export const DRAFT_HELP = `abliterate draft --sinks sinks.json [--deps deps.json] [--variants variants.json] --out findings.json
  Turns engine evidence for code the change introduced into a findings file where every entry is
  "needs-evidence". Used when no agent is configured: nothing is confirmed without a trace.
  Prints the number of high-confidence candidates on stdout.`;

// Default severity per CWE when nobody has traced the candidate yet. A reviewer replaces it.
const CWE_SEVERITY: Record<string, Severity> = {
  "CWE-89": "high", "CWE-943": "high", "CWE-78": "high", "CWE-94": "high", "CWE-502": "high", "CWE-918": "high", "CWE-22": "high",
  "CWE-798": "high", "CWE-347": "high", "CWE-829": "high", "CWE-79": "medium", "CWE-639": "medium", "CWE-601": "medium",
  "CWE-1321": "medium", "CWE-295": "medium", "CWE-330": "medium", "CWE-250": "medium",
};

interface DepsOut {
  vulnerable: { ecosystem: string; package: string; version: string; file: string; line: number; introduced: boolean;
    advisories: { id: string; aliases: string[]; summary: string; severity?: Severity; fixed?: string; kev?: boolean; epss?: number; cwe: string[]; reachability: { verdict: string; symbolUses: { path: string; line: number; symbol: string }[] } }[] }[];
}

const load = <T>(cwd: string, p?: string): T | undefined => (p ? (JSON.parse(readFileSync(resolve(cwd, p), "utf8")) as T) : undefined);

export function draft(flags: Flags, cwd: string): number {
  allowFlags(flags, ["sinks", "deps", "variants", "out"]);
  const out = str(flags, "out");
  if (!out || !str(flags, "sinks")) throw new UsageError("draft needs --sinks and --out");
  const sinks = load<{ base: string | null; head: string | null; candidates: Candidate[] }>(cwd, str(flags, "sinks"))!;
  const deps = load<DepsOut>(cwd, str(flags, "deps"));
  const variants = load<{ variants: (Candidate & { seed: string })[] }>(cwd, str(flags, "variants"));

  const findings: Finding[] = [];
  let n = 0;
  let high = 0;
  const seen = new Set<string>();
  const add = (c: Candidate, source: Finding["source"], extra = "") => {
    if (c.changedIn !== "push" || c.confidence === "low") return;
    const key = `${c.path}:${c.line}:${c.cwe}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (c.confidence === "high") high++;
    findings.push({
      id: `ABL-C${++n}`, title: c.title, status: "needs-evidence", severity: CWE_SEVERITY[c.cwe] ?? "low", confidence: c.confidence,
      cwe: [c.cwe], snapshot: "push", source, location: { path: c.path, startLine: c.line },
      rule: `Untraced candidate (${c.rule})`, actor: "Not established: no trace yet", impact: c.title,
      evidence: `Engine rule ${c.rule} matched code introduced by this change: ${c.snippet}${extra}`,
      decisiveEvidence: "Whether attacker-controlled data reaches this line on a real route without an effective guard.",
    });
  };
  for (const c of sinks.candidates) add(c, "review");
  for (const v of variants?.variants ?? []) add(v, "variants", ` (same pattern as the fix ${v.seed})`);
  for (const d of deps?.vulnerable ?? []) {
    if (!d.introduced) continue;
    for (const a of d.advisories) {
      if (a.reachability.verdict !== "symbol-used" && !a.kev) continue;
      const use = a.reachability.symbolUses[0];
      findings.push({
        id: `ABL-C${++n}`, title: `${d.package}@${d.version}: ${a.summary}`, status: "needs-evidence", severity: a.severity ?? "medium", confidence: use ? "medium" : "low",
        cwe: a.cwe.length ? a.cwe.filter((c) => /^CWE-\d+$/.test(c)) : ["CWE-1395"], snapshot: "push", source: "deps",
        location: { path: d.file, startLine: d.line },
        ...(use ? { trace: [{ path: use.path, startLine: use.line, note: `calls ${use.symbol}` }] } : {}),
        rule: "Dependencies with known vulnerabilities are not reachable from attacker-controlled input",
        actor: "Not established: no trace yet", impact: a.summary,
        evidence: `${a.id} affects ${d.package}@${d.version}${a.kev ? " (CISA KEV)" : ""}; reachability: ${a.reachability.verdict}.`,
        decisiveEvidence: use ? `Whether the arguments of ${use.symbol} at ${use.path}:${use.line} are attacker-controlled.` : "Whether the vulnerable feature is used at all.",
        advisory: { id: a.id, aliases: a.aliases, ecosystem: d.ecosystem, package: d.package, version: d.version, ...(a.fixed ? { fixed: a.fixed } : {}), ...(a.kev !== undefined ? { kev: a.kev } : {}), ...(a.epss !== undefined ? { epss: a.epss } : {}) },
      });
      if (findings[findings.length - 1]!.cwe.length === 0) findings[findings.length - 1]!.cwe = ["CWE-1395"];
    }
  }
  const report: Report = {
    version: 1,
    scope: { ...(sinks.base ? { base: sinks.base } : {}), ...(sinks.head ? { head: sinks.head } : {}), states: ["push"], complete: true, note: "engine evidence only, not reviewed by an agent" },
    findings,
  };
  writeFileSync(resolve(cwd, out), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${high}\n`);
  return EXIT.ok;
}
