export type Lang = "js" | "py" | "go" | "java" | "rb" | "php" | "yaml" | "other";

const EXT: Record<string, Lang> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", go: "go", java: "java", kt: "java", scala: "java", rb: "rb", erb: "rb", php: "php", blade: "php",
  yml: "yaml", yaml: "yaml",
};

export function langOf(path: string): Lang {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && EXT[m[1]!.toLowerCase()]) || "other";
}

// Paths that are generated, vendored or third-party: findings there are not the change author's code.
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage|target|__pycache__|\.venv|venv|bower_components)\/|\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
export const skipPath = (p: string) => SKIP.test(p);

/** Files over this size are almost always generated or data, and slow regex scans. */
export const MAX_BYTES = 1_000_000;

/**
 * Replaces comments with spaces while keeping strings, line numbers and columns intact.
 * Comments are where instructions aimed at reviewers hide, and where dead code lives;
 * strings must stay because SQL and HTML sinks are built from them.
 */
export function stripComments(text: string, lang: Lang): string {
  if (lang === "other") return text;
  const hash = lang === "py" || lang === "rb" || lang === "yaml" || lang === "php";
  const slash = lang !== "py" && lang !== "rb" && lang !== "yaml";
  const out = text.split("");
  let i = 0;
  let quote: string | null = null;
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (text.startsWith(quote, i)) { i += quote.length; quote = null; continue; }
      if (quote.length === 1 && quote !== "`" && c === "\n") quote = null; // unterminated single-line string
      i++;
      continue;
    }
    if (lang === "py" && (text.startsWith('"""', i) || text.startsWith("'''", i))) { quote = text.slice(i, i + 3); i += 3; continue; }
    if (c === '"' || c === "'" || (c === "`" && (lang === "js" || lang === "go"))) { quote = c; i++; continue; }
    if (slash && c === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); blank(i, end < 0 ? text.length : end); i = end < 0 ? text.length : end; continue; }
    if (slash && c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); const stop = end < 0 ? text.length : end + 2; blank(i, stop); i = stop; continue; }
    if (hash && c === "#" && !(lang === "yaml" && /\$\{\{[^}]*$/.test(text.slice(text.lastIndexOf("\n", i) + 1, i)))) {
      const end = text.indexOf("\n", i); blank(i, end < 0 ? text.length : end); i = end < 0 ? text.length : end; continue;
    }
    i++;
  }
  return out.join("");
}
