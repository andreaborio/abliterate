import type { Dep } from "./lockfiles";
import { ENDPOINTS, type Http } from "./net";

export interface AdvisoryInfo {
  id: string;
  aliases: string[];
  summary: string;
  severity?: "critical" | "high" | "medium" | "low";
  cvss?: string;
  cwe: string[];
  fixed?: string;
  kev?: boolean;
  epss?: number;
  epssPercentile?: number;
  /** Function or symbol names the advisory ties the flaw to, when it says so. */
  symbols: string[];
  fixCommits: string[];
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
  affected?: {
    package?: { name: string; ecosystem: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string; last_affected?: string }[] }[];
    ecosystem_specific?: { imports?: { path: string; symbols?: string[] }[]; affected_functions?: string[] };
    database_specific?: { affected_functions?: string[] };
  }[];
  references?: { type: string; url: string }[];
}

/** OSV accepts up to 1,000 queries per batch request. */
const BATCH = 1000;
/** FIRST's EPSS API accepts a comma-separated list; 100 keeps URLs well under common limits. */
const EPSS_BATCH = 100;

const sevLabel = (s?: string) => {
  const v = s?.toLowerCase();
  return v === "critical" || v === "high" || v === "low" ? v : v === "moderate" || v === "medium" ? "medium" : undefined;
};

function symbolsFrom(v: OsvVuln, pkg: string): string[] {
  const out = new Set<string>();
  for (const a of v.affected ?? []) {
    for (const imp of a.ecosystem_specific?.imports ?? []) for (const s of imp.symbols ?? []) out.add(s);
    for (const f of a.ecosystem_specific?.affected_functions ?? a.database_specific?.affected_functions ?? []) out.add(f.split(/[.:#]/).pop()!);
  }
  // GHSA npm/PyPI advisories usually name the function in prose: "via the template function", "`_.template`".
  const text = `${v.summary ?? ""}\n${v.details ?? ""}`;
  for (const m of text.matchAll(/`(?:[\w$]+\.)*([A-Za-z_$][\w$]{2,})(?:\(\))?`/g)) if (m[1] !== pkg) out.add(m[1]!);
  for (const m of text.matchAll(/\b(?:the\s+)?([A-Za-z_$][\w$]{2,})\s+(?:function|method)\b/g)) if (!/^(this|the|a|an|vulnerable|affected|same|internal|helper)$/i.test(m[1]!)) out.add(m[1]!);
  return [...out].slice(0, 12);
}

function fixedFor(v: OsvVuln, dep: Dep): string | undefined {
  for (const a of v.affected ?? []) {
    if (a.package && (a.package.name !== dep.name || a.package.ecosystem !== dep.ecosystem)) continue;
    for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) return e.fixed;
  }
  return undefined;
}

export async function lookup(deps: Dep[], http: Http): Promise<{ results: Map<Dep, AdvisoryInfo[]>; checked: number; complete: boolean }> {
  const results = new Map<Dep, AdvisoryInfo[]>();
  const unique = new Map<string, Dep[]>();
  for (const d of deps) {
    const k = `${d.ecosystem}|${d.name}|${d.version}`;
    unique.set(k, [...(unique.get(k) ?? []), d]);
  }
  const keys = [...unique.keys()];
  let checked = 0;
  let complete = true;
  const ids = new Map<string, string[]>(); // dep key -> vuln ids

  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const body = { queries: slice.map((k) => { const [ecosystem, name, version] = k.split("|"); return { package: { name, ecosystem }, version }; }) };
    const res = (await http.post(ENDPOINTS.osvBatch, body)) as { results?: { vulns?: { id: string }[] }[] } | undefined;
    if (!res?.results) { complete = false; continue; }
    res.results.forEach((r, j) => { checked++; if (r.vulns?.length) ids.set(slice[j]!, r.vulns.map((v) => v.id)); });
  }

  const details = new Map<string, OsvVuln>();
  for (const id of new Set([...ids.values()].flat())) {
    const v = (await http.get(ENDPOINTS.osvVuln(id), { maxAgeMs: 7 * 24 * 3600_000 })) as OsvVuln | undefined;
    if (v) details.set(id, v); else complete = false;
  }

  const kevFeed = (await http.get(ENDPOINTS.kev)) as { vulnerabilities?: { cveID: string }[] } | undefined;
  const kev = new Set(kevFeed?.vulnerabilities?.map((v) => v.cveID) ?? []);
  if (!kevFeed) complete = false;

  const cves = [...new Set([...details.values()].flatMap((v) => [v.id, ...(v.aliases ?? [])]).filter((a) => a.startsWith("CVE-")))];
  const epss = new Map<string, { epss: number; percentile: number }>();
  for (let i = 0; i < cves.length; i += EPSS_BATCH) {
    const r = (await http.get(ENDPOINTS.epss(cves.slice(i, i + EPSS_BATCH)))) as { data?: { cve: string; epss: string; percentile: string }[] } | undefined;
    if (!r?.data) { complete = false; continue; }
    for (const d of r.data) epss.set(d.cve, { epss: Number(d.epss), percentile: Number(d.percentile) });
  }

  for (const [k, vulnIds] of ids) {
    const sample = unique.get(k)![0]!;
    const infos: AdvisoryInfo[] = [];
    for (const id of vulnIds) {
      const v = details.get(id);
      if (!v) { infos.push({ id, aliases: [], summary: "(details unavailable)", cwe: [], symbols: [], fixCommits: [] }); continue; }
      // OSV often has both GHSA and CVE ids for one flaw; keep one entry per flaw.
      const aliases = (v.aliases ?? []).filter((a) => a !== v.id);
      const cveIds = [v.id, ...aliases].filter((a) => a.startsWith("CVE-"));
      const scores = cveIds.map((c) => epss.get(c)).filter(Boolean) as { epss: number; percentile: number }[];
      infos.push({
        id: v.id, aliases, summary: v.summary ?? (v.details ?? "").split("\n")[0]!.slice(0, 200),
        severity: sevLabel(v.database_specific?.severity),
        cvss: v.severity?.find((s) => s.type.startsWith("CVSS"))?.score,
        cwe: v.database_specific?.cwe_ids ?? [],
        fixed: fixedFor(v, sample),
        kev: cveIds.some((c) => kev.has(c)),
        ...(scores.length ? { epss: Math.max(...scores.map((s) => s.epss)), epssPercentile: Math.max(...scores.map((s) => s.percentile)) } : {}),
        symbols: symbolsFrom(v, sample.name),
        fixCommits: (v.references ?? []).filter((r) => r.type === "FIX" || /\/commit\/[0-9a-f]{7,40}/.test(r.url)).map((r) => r.url).filter((u) => /github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}/.test(u)),
      });
    }
    const seen = new Set<string>();
    const dedup = infos.filter((a) => { const all = [a.id, ...a.aliases]; if (all.some((x) => seen.has(x))) return false; all.forEach((x) => seen.add(x)); return true; });
    for (const d of unique.get(k)!) results.set(d, dedup);
  }
  return { results, checked, complete };
}

/** KEV first (exploited in the wild), then EPSS, then advisory severity. */
export function priority(a: AdvisoryInfo): number {
  const sev = { critical: 4, high: 3, medium: 2, low: 1 }[a.severity ?? "low"] ?? 0;
  return (a.kev ? 100 : 0) + (a.epss ?? 0) * 10 + sev;
}
