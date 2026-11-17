// Lockfile and manifest parsers. Exact resolved versions only: ranges cannot be checked
// against advisories honestly, so unpinned entries are reported as "unresolved".

export type Ecosystem = "npm" | "PyPI" | "Go" | "crates.io" | "RubyGems" | "Packagist";

export interface Dep {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  file: string;
  line: number;
}

export const LOCKFILES: Record<string, Ecosystem> = {
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "pnpm-lock.yaml": "npm", "yarn.lock": "npm",
  "poetry.lock": "PyPI", "uv.lock": "PyPI", "Pipfile.lock": "PyPI", "requirements.txt": "PyPI",
  "go.mod": "Go", "Cargo.lock": "crates.io", "Gemfile.lock": "RubyGems", "composer.lock": "Packagist",
};

export const isLockfile = (path: string) => {
  const base = path.split("/").pop()!;
  return base in LOCKFILES || /^requirements[\w.-]*\.txt$/.test(base);
};

function lineOf(lines: string[], needle: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (needle.test(lines[i]!)) return i + 1;
  return 1;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function npmLock(file: string, text: string, lines: string[]): Dep[] {
  const data = JSON.parse(text);
  const out: Dep[] = [];
  if (data.packages) {
    for (const [key, v] of Object.entries<{ version?: string; link?: boolean }>(data.packages)) {
      if (!key || v.link || !v.version) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      out.push({ ecosystem: "npm", name, version: v.version, file, line: lineOf(lines, new RegExp(`"${esc(key)}"`)) });
    }
  } else if (data.dependencies) {
    const walk = (deps: Record<string, { version: string; dependencies?: object }>) => {
      for (const [name, v] of Object.entries(deps)) {
        if (v.version && !/^(file|link|git)/.test(v.version)) out.push({ ecosystem: "npm", name, version: v.version, file, line: lineOf(lines, new RegExp(`"${esc(name)}"\\s*:\\s*\\{`)) });
        if (v.dependencies) walk(v.dependencies as Record<string, { version: string }>);
      }
    };
    walk(data.dependencies);
  }
  return out;
}

function pnpmLock(file: string, lines: string[]): Dep[] {
  const out: Dep[] = [];
  let inPackages = false;
  lines.forEach((l, i) => {
    if (/^(packages|snapshots):\s*$/.test(l)) { inPackages = l.startsWith("packages"); return; }
    if (/^\S/.test(l)) inPackages = false;
    if (!inPackages) return;
    // v6: "  /name@1.2.3:"  v9: "  name@1.2.3:"  scoped: "  '@scope/name@1.2.3':"
    const m = /^ {2}['"]?\/?((?:@[^/@\s]+\/)?[^@\s'"]+)@([0-9][^(:'"\s]*)/.exec(l);
    if (m) out.push({ ecosystem: "npm", name: m[1]!, version: m[2]!, file, line: i + 1 });
  });
  return out;
}

function yarnLock(file: string, lines: string[]): Dep[] {
  const out: Dep[] = [];
  let names: string[] = [];
  let at = 0;
  lines.forEach((l, i) => {
    if (/^\S.*:\s*$/.test(l) && !l.startsWith("#") && !l.startsWith("__metadata")) {
      names = l.replace(/:\s*$/, "").split(/,\s*/).map((s) => s.replace(/^"|"$/g, "").replace(/@(npm:)?[^@]*$/, "")).filter(Boolean);
      at = i + 1;
      return;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(l);
    if (v && names.length) { out.push({ ecosystem: "npm", name: names[0]!, version: v[1]!, file, line: at }); names = []; }
  });
  return out;
}

function tomlPackages(file: string, lines: string[], ecosystem: Ecosystem): Dep[] {
  const out: Dep[] = [];
  let name: string | undefined;
  let at = 0;
  lines.forEach((l, i) => {
    if (/^\[\[package\]\]/.test(l)) { name = undefined; at = i + 1; return; }
    const n = /^name\s*=\s*"([^"]+)"/.exec(l);
    if (n) { name = n[1]; return; }
    const v = /^version\s*=\s*"([^"]+)"/.exec(l);
    if (v && name) { out.push({ ecosystem, name, version: v[1]!, file, line: at }); name = undefined; }
  });
  return out;
}

function requirements(file: string, lines: string[]): Dep[] {
  return lines.flatMap((l, i) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9.+!_-]+)/.exec(l);
    return m ? [{ ecosystem: "PyPI" as const, name: m[1]!, version: m[3]!, file, line: i + 1 }] : [];
  });
}

function pipfileLock(file: string, text: string, lines: string[]): Dep[] {
  const data = JSON.parse(text);
  const out: Dep[] = [];
  for (const section of ["default", "develop"]) {
    for (const [name, v] of Object.entries<{ version?: string }>(data[section] ?? {})) {
      const m = /^==(.+)$/.exec(v.version ?? "");
      if (m) out.push({ ecosystem: "PyPI", name, version: m[1]!, file, line: lineOf(lines, new RegExp(`"${esc(name)}"\\s*:`)) });
    }
  }
  return out;
}

function goMod(file: string, lines: string[]): Dep[] {
  let block = false;
  return lines.flatMap((l, i) => {
    if (/^require\s*\(/.test(l)) { block = true; return []; }
    if (block && /^\)/.test(l)) { block = false; return []; }
    const m = (block ? /^\s*([^\s]+)\s+(v[^\s]+)/ : /^require\s+([^\s]+)\s+(v[^\s]+)/).exec(l);
    return m ? [{ ecosystem: "Go" as const, name: m[1]!, version: m[2]!, file, line: i + 1 }] : [];
  });
}

function gemfileLock(file: string, lines: string[]): Dep[] {
  let specs = false;
  return lines.flatMap((l, i) => {
    if (/^\s{2}specs:\s*$/.test(l)) { specs = true; return []; }
    if (/^\S/.test(l)) specs = false;
    const m = specs ? /^ {4}([A-Za-z0-9_.-]+) \(([^)\s]+)\)/.exec(l) : null;
    return m ? [{ ecosystem: "RubyGems" as const, name: m[1]!, version: m[2]!, file, line: i + 1 }] : [];
  });
}

function composerLock(file: string, text: string, lines: string[]): Dep[] {
  const data = JSON.parse(text);
  return [...(data.packages ?? []), ...(data["packages-dev"] ?? [])].map((p: { name: string; version: string }) => ({
    ecosystem: "Packagist" as const, name: p.name, version: p.version.replace(/^v/, ""), file, line: lineOf(lines, new RegExp(`"name"\\s*:\\s*"${esc(p.name)}"`)),
  }));
}

/** Parses one lockfile. Throws on malformed input so the caller can report the file as unreadable. */
export function parseLockfile(file: string, text: string): Dep[] {
  const base = file.split("/").pop()!;
  const lines = text.split(/\r?\n/);
  switch (base) {
    case "package-lock.json": case "npm-shrinkwrap.json": return npmLock(file, text, lines);
    case "pnpm-lock.yaml": return pnpmLock(file, lines);
    case "yarn.lock": return yarnLock(file, lines);
    case "poetry.lock": case "uv.lock": return tomlPackages(file, lines, "PyPI");
    case "Cargo.lock": return tomlPackages(file, lines, "crates.io");
    case "Pipfile.lock": return pipfileLock(file, text, lines);
    case "go.mod": return goMod(file, lines);
    case "Gemfile.lock": return gemfileLock(file, lines);
    case "composer.lock": return composerLock(file, text, lines);
    default: return /^requirements[\w.-]*\.txt$/.test(base) ? requirements(file, lines) : [];
  }
}
