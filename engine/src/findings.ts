// The findings contract shared by the skill, the report command, the GitHub Action
// and the evals. schema/findings.schema.json documents the same shape for humans.

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const STATUSES = ["confirmed", "needs-evidence", "pre-existing"] as const;
export const SNAPSHOTS = ["push", "index", "worktree", "file"] as const;
export const SOURCES = ["review", "deps", "variants"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Status = (typeof STATUSES)[number];
export type Snapshot = (typeof SNAPSHOTS)[number];

export interface Location {
  path: string;
  startLine: number;
  endLine?: number;
}

export interface TraceStep extends Location {
  note: string;
}

export interface Advisory {
  id: string;
  aliases?: string[];
  ecosystem: string;
  package: string;
  version: string;
  fixed?: string;
  kev?: boolean;
  epss?: number;
}

export interface Finding {
  id: string;
  title: string;
  status: Status;
  severity: Severity;
  confidence: (typeof CONFIDENCES)[number];
  cwe: string[];
  snapshot: Snapshot;
  source: (typeof SOURCES)[number];
  location: Location;
  rule: string;
  actor: string;
  impact: string;
  evidence: string;
  fix?: string;
  test?: string;
  decisiveEvidence?: string;
  trace?: TraceStep[];
  advisory?: Advisory;
}

export interface Report {
  version: 1;
  scope: { base?: string; head?: string; states: Snapshot[]; complete: boolean; note?: string };
  findings: Finding[];
}

/** Ranks used for thresholds and sorting: higher is worse. */
export const severityRank = (s: Severity) => SEVERITIES.length - SEVERITIES.indexOf(s);

type Errors = string[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (e: Errors, at: string, v: unknown, required = true) => {
  if (v === undefined && !required) return;
  if (typeof v !== "string" || v.trim() === "") e.push(`${at}: expected a non-empty string`);
};
const oneOf = (e: Errors, at: string, v: unknown, allowed: readonly string[]) => {
  if (typeof v !== "string" || !allowed.includes(v)) e.push(`${at}: expected one of ${allowed.join(", ")}; got ${JSON.stringify(v)}`);
};
const line = (e: Errors, at: string, v: unknown, required = true) => {
  if (v === undefined && !required) return;
  if (!Number.isInteger(v) || (v as number) < 1) e.push(`${at}: expected a 1-based line number`);
};
const relPath = (e: Errors, at: string, v: unknown) => {
  str(e, at, v);
  if (typeof v === "string" && (v.startsWith("/") || v.split(/[\\/]/).includes(".."))) {
    e.push(`${at}: use a path relative to the repository root, without "..": ${v}`);
  }
};

function location(e: Errors, at: string, v: unknown) {
  if (!isObj(v)) return void e.push(`${at}: expected an object with path and startLine`);
  relPath(e, `${at}.path`, v.path);
  line(e, `${at}.startLine`, v.startLine);
  line(e, `${at}.endLine`, v.endLine, false);
  if (Number.isInteger(v.endLine) && Number.isInteger(v.startLine) && (v.endLine as number) < (v.startLine as number)) {
    e.push(`${at}.endLine: must be >= startLine`);
  }
}

function finding(e: Errors, at: string, v: unknown) {
  if (!isObj(v)) return void e.push(`${at}: expected an object`);
  str(e, `${at}.id`, v.id);
  str(e, `${at}.title`, v.title);
  oneOf(e, `${at}.status`, v.status, STATUSES);
  oneOf(e, `${at}.severity`, v.severity, SEVERITIES);
  oneOf(e, `${at}.confidence`, v.confidence, CONFIDENCES);
  oneOf(e, `${at}.snapshot`, v.snapshot, SNAPSHOTS);
  oneOf(e, `${at}.source`, v.source, SOURCES);
  if (!Array.isArray(v.cwe) || v.cwe.length === 0) e.push(`${at}.cwe: expected at least one id such as "CWE-89"`);
  else v.cwe.forEach((c, i) => {
    if (typeof c !== "string" || !/^CWE-\d{1,5}$/.test(c)) e.push(`${at}.cwe[${i}]: expected "CWE-<number>"; got ${JSON.stringify(c)}`);
  });
  location(e, `${at}.location`, v.location);
  for (const k of ["rule", "actor", "impact", "evidence"] as const) str(e, `${at}.${k}`, v[k]);
  for (const k of ["fix", "test", "decisiveEvidence"] as const) str(e, `${at}.${k}`, v[k], false);
  if (v.status === "needs-evidence") str(e, `${at}.decisiveEvidence`, v.decisiveEvidence);
  if (v.status === "confirmed") {
    str(e, `${at}.fix`, v.fix);
    str(e, `${at}.test`, v.test);
  }
  if (v.trace !== undefined) {
    if (!Array.isArray(v.trace)) e.push(`${at}.trace: expected an array`);
    else v.trace.forEach((t, i) => {
      location(e, `${at}.trace[${i}]`, t);
      if (isObj(t)) str(e, `${at}.trace[${i}].note`, t.note);
    });
  }
  if (v.source === "deps") {
    const a = v.advisory;
    if (!isObj(a)) e.push(`${at}.advisory: required when source is "deps"`);
    else {
      for (const k of ["id", "ecosystem", "package", "version"] as const) str(e, `${at}.advisory.${k}`, a[k]);
      str(e, `${at}.advisory.fixed`, a.fixed, false);
      if (a.epss !== undefined && (typeof a.epss !== "number" || a.epss < 0 || a.epss > 1)) e.push(`${at}.advisory.epss: expected a probability between 0 and 1`);
      if (a.kev !== undefined && typeof a.kev !== "boolean") e.push(`${at}.advisory.kev: expected a boolean`);
    }
  }
}

/** Returns a list of precise, actionable errors; empty means valid. */
export function validateReport(v: unknown): Errors {
  const e: Errors = [];
  if (!isObj(v)) return ["root: expected an object with version, scope and findings"];
  if (v.version !== 1) e.push(`version: expected 1; got ${JSON.stringify(v.version)}`);
  if (!isObj(v.scope)) e.push("scope: expected an object");
  else {
    if (!Array.isArray(v.scope.states)) e.push("scope.states: expected an array of snapshots");
    else v.scope.states.forEach((s, i) => oneOf(e, `scope.states[${i}]`, s, SNAPSHOTS));
    if (typeof v.scope.complete !== "boolean") e.push("scope.complete: expected true or false (false = review incomplete)");
    str(e, "scope.base", v.scope.base, false);
    str(e, "scope.head", v.scope.head, false);
  }
  if (!Array.isArray(v.findings)) e.push("findings: expected an array (use [] when nothing is confirmed)");
  else {
    const ids = new Set<string>();
    v.findings.forEach((f, i) => {
      finding(e, `findings[${i}]`, f);
      if (isObj(f) && typeof f.id === "string") {
        if (ids.has(f.id)) e.push(`findings[${i}].id: duplicate id ${f.id}`);
        ids.add(f.id);
      }
    });
  }
  return e;
}
