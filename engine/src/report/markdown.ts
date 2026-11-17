import { severityRank, type Finding, type Report } from "../findings";

const bySeverity = (a: Finding, b: Finding) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id);
const loc = (f: Finding) => `\`${f.location.path}:${f.location.startLine}\``;

function block(f: Finding): string {
  const lines = [
    `### ${f.severity.toUpperCase()} · ${f.cwe.join(", ")} · ${f.title}`,
    "",
    `${loc(f)} · ${f.snapshot} · confidence ${f.confidence}${f.advisory ? ` · ${f.advisory.package}@${f.advisory.version} (${f.advisory.id}${f.advisory.kev ? ", in CISA KEV" : ""})` : ""}`,
    "",
    `- **Rule broken:** ${f.rule}`,
    `- **Who:** ${f.actor}`,
    `- **Effect:** ${f.impact}`,
    `- **Evidence:** ${f.evidence}`,
  ];
  if (f.fix) lines.push(`- **Fix:** ${f.fix}`);
  if (f.test) lines.push(`- **Test:** ${f.test}`);
  if (f.decisiveEvidence) lines.push(`- **Would decide it:** ${f.decisiveEvidence}`);
  return lines.join("\n");
}

/** Markdown for terminals and the sticky PR comment. Opens with the decision. */
export function toMarkdown(report: Report, opts: { failOn?: string; blocking: Finding[] }): string {
  const confirmed = report.findings.filter((f) => f.status === "confirmed").sort(bySeverity);
  const open = report.findings.filter((f) => f.status === "needs-evidence").sort(bySeverity);
  const old = report.findings.filter((f) => f.status === "pre-existing").sort(bySeverity);

  const decision = opts.blocking.length
    ? `**Block:** ${opts.blocking.length} confirmed ${opts.blocking.length === 1 ? "vulnerability" : "vulnerabilities"} at or above \`${opts.failOn}\` introduced by this change.`
    : confirmed.length
      ? `**Review:** ${confirmed.length} confirmed ${confirmed.length === 1 ? "issue" : "issues"} below the blocking threshold.`
      : "**No confirmed vulnerabilities introduced by this change.**";

  const out = [
    "<!-- abliterate-report -->",
    "## abliterate review",
    "",
    decision,
    "",
    `Scope: ${report.scope.base ? `\`${report.scope.base}\`…` : ""}${report.scope.head ? `\`${report.scope.head.slice(0, 12)}\`` : "working copy"} · states: ${report.scope.states.join(", ") || "none"}${report.scope.complete ? "" : " · **review incomplete**"}${report.scope.note ? ` · ${report.scope.note}` : ""}`,
  ];
  if (confirmed.length) out.push("", "## Confirmed", "", confirmed.map(block).join("\n\n"));
  if (open.length) out.push("", "## Needs evidence (not counted)", "", open.map(block).join("\n\n"));
  if (old.length) out.push("", "## Pre-existing (not introduced here)", "", ...old.map((f) => `- ${f.severity} · ${f.cwe.join(", ")} · ${f.title} · ${loc(f)}`));
  out.push("", "<sub>Findings are confirmed by tracing the code path; candidates the engine raised and the review disproved are not listed.</sub>");
  return out.join("\n") + "\n";
}
