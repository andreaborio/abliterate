import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SEVERITIES, severityRank, validateReport, type Report, type Severity } from "../findings";
import { toMarkdown } from "../report/markdown";
import { toSarif } from "../report/sarif";
import { allowFlags, EXIT, str, UsageError, VERSION, type Flags } from "../util";

export const REPORT_HELP = `abliterate report --in findings.json [--sarif out.sarif] [--md out.md] [--fail-on critical|high|medium|low|none]
  Validates findings.json and writes SARIF 2.1.0 and/or markdown. Prints errors to fix when invalid.
  Exit 1 when a confirmed finding introduced by the change is at or above --fail-on (default: none).`;

export function report(flags: Flags, cwd: string): number {
  allowFlags(flags, ["in", "sarif", "md", "fail-on", "root", "include-unconfirmed"]);
  const input = str(flags, "in");
  if (!input) throw new UsageError("report needs --in findings.json");
  const failOn = str(flags, "fail-on") ?? "none";
  if (failOn !== "none" && !SEVERITIES.includes(failOn as Severity)) throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(", ")}, none`);

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(resolve(cwd, input), "utf8"));
  } catch (err) {
    process.stderr.write(`Cannot read ${input} as JSON: ${(err as Error).message}\n`);
    return EXIT.usage;
  }
  const errors = validateReport(data);
  if (errors.length) {
    process.stderr.write(`${input} is not a valid abliterate report (${errors.length} problem${errors.length > 1 ? "s" : ""}):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write("Fix these fields and run report again. Schema: skills/abliterate-review/reference/report-format.md\n");
    return EXIT.usage;
  }
  const rep = data as Report;
  const root = resolve(cwd, str(flags, "root") ?? ".");
  const blocking = failOn === "none" ? [] : rep.findings.filter(
    (f) => f.status === "confirmed" && severityRank(f.severity) >= severityRank(failOn as Severity),
  );

  const sarifPath = str(flags, "sarif");
  if (sarifPath) {
    const sarif = toSarif(rep, { root, version: VERSION, includeUnconfirmed: flags["include-unconfirmed"] === true });
    writeFileSync(resolve(cwd, sarifPath), JSON.stringify(sarif, null, 2) + "\n");
  }
  const md = toMarkdown(rep, { failOn, blocking });
  const mdPath = str(flags, "md");
  if (mdPath) writeFileSync(resolve(cwd, mdPath), md);
  if (!sarifPath && !mdPath) process.stdout.write(md);
  return blocking.length ? EXIT.findings : EXIT.ok;
}
