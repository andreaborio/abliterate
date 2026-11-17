import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { langOf, MAX_BYTES, skipPath, stripComments } from "../lang";
import type { Ecosystem } from "./lockfiles";

export interface Reach {
  verdict: "symbol-used" | "imported" | "not-imported" | "unknown";
  imports: { path: string; line: number }[];
  symbolUses: { path: string; line: number; symbol: string }[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function importPattern(ecosystem: Ecosystem, name: string): RegExp | undefined {
  const n = esc(name);
  switch (ecosystem) {
    case "npm": return new RegExp(`(require\\(\\s*|from\\s+|import\\s*\\(\\s*|import\\s+)["']${n}(/[^"']*)?["']`);
    case "PyPI": { const mod = esc(name.toLowerCase().replace(/-/g, "_")); return new RegExp(`^\\s*(from\\s+${mod}(\\.|\\s)|import\\s+${mod}\\b)`, "i"); }
    case "Go": return new RegExp(`"${n}(/[^"]*)?"`);
    case "RubyGems": return new RegExp(`require\\s+["']${n}`);
    case "crates.io": return new RegExp(`\\b(use|extern crate)\\s+${esc(name.replace(/-/g, "_"))}\\b`);
    case "Packagist": return undefined; // autoloaded by namespace; cannot map package name to imports reliably
  }
}

const SOURCE_LANGS: Record<Ecosystem, string[]> = {
  npm: ["js"], PyPI: ["py"], Go: ["go"], RubyGems: ["rb"], "crates.io": ["other"], Packagist: ["php"],
};

/**
 * Where the package is imported and whether any symbol named by the advisory is used in
 * those files. A hint for the reviewer, not proof: dynamic imports and re-exports are missed.
 */
export function reachability(root: string, files: string[], ecosystem: Ecosystem, name: string, symbols: string[]): Reach {
  const pat = importPattern(ecosystem, name);
  if (!pat) return { verdict: "unknown", imports: [], symbolUses: [] };
  const imports: Reach["imports"] = [];
  const symbolUses: Reach["symbolUses"] = [];
  const symRe = symbols.length ? new RegExp(`(?:[.\\s(:]|^)(${symbols.map(esc).join("|")})\\s*\\(`) : undefined;
  for (const path of files) {
    if (skipPath(path)) continue;
    const lang = langOf(path);
    if (!SOURCE_LANGS[ecosystem].includes(lang) && !(ecosystem === "crates.io" && path.endsWith(".rs"))) continue;
    let text: string;
    try {
      const p = join(root, path);
      if (statSync(p).size > MAX_BYTES) continue;
      text = stripComments(readFileSync(p, "utf8"), lang);
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    let imported = false;
    lines.forEach((l, i) => { if (pat.test(l)) { imported = true; imports.push({ path, line: i + 1 }); } });
    if (!imported || !symRe) continue;
    lines.forEach((l, i) => { const m = symRe.exec(l); if (m) symbolUses.push({ path, line: i + 1, symbol: m[1]! }); });
  }
  const verdict = symbolUses.length ? "symbol-used" : imports.length ? "imported" : "not-imported";
  return { verdict, imports: imports.slice(0, 20), symbolUses: symbolUses.slice(0, 20) };
}
