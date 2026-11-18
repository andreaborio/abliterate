import { createHash } from "node:crypto";
import type { Finding, Report, Severity } from "../findings";
import { readWorktreeText } from "../worktree";

// GitHub code scanning reads "security-severity" (0.0-10.0) on rules to bucket
// alerts. These are the midpoints of GitHub's critical/high/medium/low bands.
const SECURITY_SEVERITY: Record<Severity, string> = { critical: "9.5", high: "7.5", medium: "5.0", low: "2.0" };
const LEVEL: Record<Severity, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note" };

const INFORMATION_URI = "https://github.com/andreaborio/abliterate";

/** Text of a source line with whitespace collapsed, so fingerprints survive reformatting and line shifts. */
function lineText(root: string, path: string, line: number): string {
  const text = readWorktreeText(root, path);
  return text?.split(/\r?\n/)[line - 1]?.replace(/\s+/g, " ").trim() ?? "";
}

export function fingerprint(root: string, f: Finding): string {
  const anchor = lineText(root, f.location.path, f.location.startLine) || f.title.toLowerCase();
  return createHash("sha256").update([f.cwe.slice().sort().join(","), f.location.path, anchor].join("\n")).digest("hex");
}

const ruleId = (f: Finding) => (f.source === "deps" && f.advisory ? f.advisory.id : f.cwe[0]!);

export function toSarif(report: Report, opts: { root: string; version: string; includeUnconfirmed: boolean }) {
  const findings = report.findings.filter((f) => opts.includeUnconfirmed || f.status !== "needs-evidence");
  const rules = new Map<string, { id: string; name: string; shortDescription: { text: string }; helpUri?: string; properties: Record<string, unknown> }>();

  for (const f of findings) {
    const id = ruleId(f);
    const existing = rules.get(id);
    // A rule's security-severity is the worst severity seen under it in this run.
    const sev = existing && Number(existing.properties["security-severity"]) >= Number(SECURITY_SEVERITY[f.severity])
      ? (existing.properties["security-severity"] as string)
      : SECURITY_SEVERITY[f.severity];
    const cweNumber = f.cwe[0]!.slice(4);
    rules.set(id, {
      id,
      name: f.source === "deps" ? `VulnerableDependency/${id}` : id,
      shortDescription: { text: f.source === "deps" && f.advisory ? `Known vulnerability in ${f.advisory.package}` : `${f.cwe[0]}` },
      helpUri: f.source === "deps" ? `https://osv.dev/vulnerability/${encodeURIComponent(id)}` : `https://cwe.mitre.org/data/definitions/${cweNumber}.html`,
      properties: {
        "security-severity": sev,
        tags: ["security", ...f.cwe.map((c) => `external/cwe/${c.toLowerCase()}`)],
      },
    });
  }

  const results = findings.map((f) => {
    const message = [`${f.title}.`, f.impact, f.fix ? `Fix: ${f.fix}` : "", f.decisiveEvidence ? `Needs: ${f.decisiveEvidence}` : ""]
      .filter(Boolean).join(" ");
    return {
      ruleId: ruleId(f),
      level: f.status === "needs-evidence" ? "note" : LEVEL[f.severity],
      message: { text: message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.location.path, uriBaseId: "%SRCROOT%" },
          region: { startLine: f.location.startLine, ...(f.location.endLine ? { endLine: f.location.endLine } : {}) },
        },
      }],
      ...(f.trace?.length ? {
        codeFlows: [{
          threadFlows: [{
            locations: f.trace.map((t) => ({
              location: {
                physicalLocation: { artifactLocation: { uri: t.path, uriBaseId: "%SRCROOT%" }, region: { startLine: t.startLine } },
                message: { text: t.note },
              },
            })),
          }],
        }],
      } : {}),
      partialFingerprints: { "abliterate/v1": fingerprint(opts.root, f) },
      ...(f.status === "pre-existing" ? { baselineState: "unchanged" } : {}),
      properties: {
        abliteratId: f.id,
        status: f.status,
        snapshot: f.snapshot,
        confidence: f.confidence,
        ...(f.advisory ? { advisory: f.advisory } : {}),
      },
    };
  });

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "abliterate", semanticVersion: opts.version, informationUri: INFORMATION_URI, rules: [...rules.values()] } },
      results,
    }],
  };
}
