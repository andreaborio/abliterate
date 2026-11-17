import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The only hosts the engine ever contacts. Requests carry package names, versions and
// advisory ids: never file contents, paths or repository names.
export const ENDPOINTS = {
  osvBatch: "https://api.osv.dev/v1/querybatch",
  osvVuln: (id: string) => `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
  kev: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  epss: (cves: string[]) => `https://api.first.org/data/v1/epss?cve=${cves.map(encodeURIComponent).join(",")}`,
  githubPatch: (owner: string, repo: string, sha: string) => `https://github.com/${owner}/${repo}/commit/${sha}.patch`,
};

/** Per-request timeout: OSV and FIRST answer in well under a second; 20 s tolerates slow links without hanging CI. */
const TIMEOUT_MS = 20_000;

export function cacheDir(): string {
  const base = process.env.ABLITERATE_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "abliterate");
  mkdirSync(base, { recursive: true });
  return base;
}

const key = (url: string, body?: string) => createHash("sha256").update(url + "\n" + (body ?? "")).digest("hex").slice(0, 32);

export interface Http {
  offline: boolean;
  /** Returns parsed JSON or text; undefined when offline and not cached, or on network failure. */
  get(url: string, opts?: { maxAgeMs?: number; text?: boolean }): Promise<unknown>;
  post(url: string, body: unknown, opts?: { maxAgeMs?: number }): Promise<unknown>;
  failures: string[];
}

/**
 * HTTP with a content cache. ABLITERATE_HTTP_REPLAY=dir serves recorded responses only
 * (tests); ABLITERATE_HTTP_RECORD=dir also writes every live response there.
 */
export function makeHttp(offline: boolean): Http {
  const replay = process.env.ABLITERATE_HTTP_REPLAY;
  const record = process.env.ABLITERATE_HTTP_RECORD;
  const dir = replay || cacheDir();
  const failures: string[] = [];

  async function go(method: "GET" | "POST", url: string, body: unknown, maxAgeMs: number, text: boolean) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const file = join(dir, `${key(url, payload)}.${text ? "txt" : "json"}`);
    const fresh = existsSync(file) && (replay || Date.now() - statSync(file).mtimeMs < maxAgeMs);
    if (fresh) {
      const raw = readFileSync(file, "utf8");
      return text ? raw : JSON.parse(raw);
    }
    if (offline || replay) {
      if (existsSync(file)) { const raw = readFileSync(file, "utf8"); return text ? raw : JSON.parse(raw); }
      return undefined;
    }
    try {
      const res = await fetch(url, {
        method, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", "user-agent": "abliterate-cli" },
      });
      if (!res.ok) { failures.push(`${method} ${new URL(url).host} → HTTP ${res.status}`); return undefined; }
      const raw = await res.text();
      writeFileSync(file, raw);
      if (record) { mkdirSync(record, { recursive: true }); writeFileSync(join(record, `${key(url, payload)}.${text ? "txt" : "json"}`), raw); }
      return text ? raw : JSON.parse(raw);
    } catch (err) {
      failures.push(`${method} ${new URL(url).host} → ${(err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message}`);
      if (existsSync(file)) { const raw = readFileSync(file, "utf8"); return text ? raw : JSON.parse(raw); }
      return undefined;
    }
  }

  return {
    offline,
    failures,
    get: (url, o = {}) => go("GET", url, undefined, o.maxAgeMs ?? 24 * 3600_000, !!o.text),
    post: (url, body, o = {}) => go("POST", url, body, o.maxAgeMs ?? 12 * 3600_000, false),
  };
}
