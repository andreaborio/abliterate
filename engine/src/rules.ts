import type { Lang } from "./lang";

// Candidate rules. A hit is a place a reviewer must trace, not a finding: the skill
// confirms or disproves it. Rules favour recall on changed code and suppress a hit
// only when a recognised guard sits in the same block (reported as "guarded").

export interface Ctx {
  path: string;
  lang: Lang;
  /** Original lines. */
  raw: string[];
  /** Lines with comments blanked (strings kept). */
  code: string[];
}

export interface Hit {
  line: number; // 1-based
  guarded?: string;
  note?: string;
}

export interface Rule {
  id: string;
  cwe: string;
  title: string;
  confidence: "high" | "medium" | "low";
  langs: Lang[] | "any";
  files?: RegExp;
  match(ctx: Ctx): Hit[];
}

/* ---------- helpers ---------- */

const SQL = /\b(select|insert\s+into|update\s+\w+\s+set|delete\s+from|where|order\s+by|union)\b/i;
export const JS_SOURCE = /\breq(?:uest)?\.(query|body|params|headers|cookies)\b|\bctx\.(query|request\.body|params)\b|\bsearchParams\.get\(|\bformData\.get\(/;
export const PY_SOURCE = /\brequest\.(args|form|values|json|get_json|data|files|GET|POST|body|query_params|path_params|cookies|headers)\b/;
const ESCAPED = /^\s*(escape|esc|encode\w*|sanitize\w*|DOMPurify\.sanitize|purify|xss|he\.encode|htmlEscape|escapeHtml|_\.escape|String\(Number)/;

/** Enclosing block of line i: Python by indentation, brace languages by matching braces. Returns [start, end] 0-based inclusive. */
export function blockOf(ctx: Ctx, i: number): [number, number] {
  const lines = ctx.code;
  if (ctx.lang === "py" || ctx.lang === "rb" || ctx.lang === "yaml") {
    const indent = (s: string) => s.length - s.trimStart().length;
    const opener = ctx.lang === "py" ? /^\s*(async\s+)?(def|class)\s/ : ctx.lang === "rb" ? /^\s*(def|class|module)\s/ : /^\S/;
    let def = -1;
    for (let k = i; k >= 0; k--) {
      if (opener.test(lines[k]!) && (k === i || indent(lines[k]!) < indent(lines[i]!))) { def = k; break; }
    }
    if (def < 0) return [Math.max(0, i - 15), Math.min(lines.length - 1, i + 15)];
    const base = indent(lines[def]!);
    let end = Math.max(def, i);
    for (let k = def + 1; k < lines.length; k++) {
      if (lines[k]!.trim() === "") continue;
      if (indent(lines[k]!) <= base) break;
      end = k;
    }
    let start = def;
    while (start > 0 && /^\s*@/.test(lines[start - 1]!)) start--;
    return [start, Math.max(end, i)];
  }
  // Brace languages: walk up to the nearest line that opens a function-like block.
  let start = i;
  for (let k = i; k >= Math.max(0, i - 80); k--) {
    if (/(=>\s*\{|\bfunction\b[^;]*\{|\)\s*\{\s*$|\bfunc\b[^;]*\{)/.test(lines[k]!)) { start = k; break; }
  }
  let depth = 0;
  let end = i;
  for (let k = start; k < Math.min(lines.length, start + 200); k++) {
    for (const ch of lines[k]!) { if (ch === "{") depth++; else if (ch === "}") depth--; }
    end = k;
    if (depth <= 0 && k > start) break;
  }
  return [start, Math.max(end, i)];
}

/** Identifiers assigned from a source expression inside lines [from, to]. One hop, by design. */
export function taintedNames(ctx: Ctx, from: number, to: number, source: RegExp): Set<string> {
  const names = new Set<string>();
  for (let k = from; k <= to; k++) {
    const l = ctx.code[k]!;
    if (!source.test(l)) continue;
    const destructured = /(?:const|let|var)\s*\{([^}]+)\}\s*=/.exec(l);
    if (destructured) destructured[1]!.split(",").forEach((n) => names.add(n.split(":").pop()!.trim().split("=")[0]!.trim()));
    const simple = /(?:const|let|var|final|\bString)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]| ]+)?=(?!=)/.exec(l);
    if (simple && !/^(if|while|return)$/.test(simple[1]!)) names.add(simple[1]!);
    const tuple = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=(?!=)/.exec(l);
    if (tuple) tuple[1]!.split(",").forEach((n) => names.add(n.trim()));
  }
  names.delete("");
  return names;
}

const mentions = (text: string, names: Set<string>) => [...names].some((n) => new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, "\\$")}\\b`).test(text));

/** A rule that fires per line. `unless` suppresses on the same line; `guard` suppresses (as guarded) within the block. */
function lineRule(def: Omit<Rule, "match"> & {
  re: RegExp;
  unless?: RegExp;
  guard?: RegExp;
  raw?: boolean;
  needs?: (line: string, ctx: Ctx, i: number) => boolean;
}): Rule {
  return {
    ...def,
    match(ctx) {
      const hits: Hit[] = [];
      const lines = def.raw ? ctx.raw : ctx.code;
      lines.forEach((l, i) => {
        if (!def.re.test(l) || def.unless?.test(l) || (def.needs && !def.needs(l, ctx, i))) return;
        let guarded: string | undefined;
        if (def.guard) {
          const [s, e] = blockOf(ctx, i);
          const g = ctx.code.slice(s, e + 1).join("\n").match(def.guard);
          if (g) guarded = g[0].trim().slice(0, 80);
        }
        hits.push({ line: i + 1, ...(guarded ? { guarded } : {}) });
      });
      return hits;
    },
  };
}

/** Sink call whose argument is a direct source or a one-hop tainted name from the same block. */
function taintRule(def: Omit<Rule, "match"> & { sink: RegExp; source: RegExp; guard?: RegExp; unless?: RegExp }): Rule {
  return lineRule({
    ...def,
    re: def.sink,
    needs: (line, ctx, i) => {
      if (def.source.test(line)) return true;
      const [s] = blockOf(ctx, i);
      const names = taintedNames(ctx, s, i, def.source);
      const call = line.slice(line.search(def.sink));
      return mentions(call, names);
    },
  });
}

/* ---------- rules ---------- */

function pathCode(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, match => match.replace(/[^\n]/g, " "));
}

// Source/variable matching includes interpolation, but excludes literal text.
function pathExpression(text: string, lang: Lang): string {
  let code = pathCode(text);
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (lang === "php") code += " " + match[0].replace(/\\./g, " ");
    else for (const interpolation of match[0].matchAll(/(?<!\\)#\{([^}]*)\}/g)) code += " " + interpolation[1];
  }
  return code;
}

function pathCallEnd(text: string, open: number): number {
  let depth = 1;
  let quote = "";
  let end = open + 1;
  for (; end < text.length && depth > 0; end++) {
    const ch = text[end]!;
    if (quote) {
      if (ch === "\\") end++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth === 0 ? end : -1;
}

function resolvedPath(value: string, lang: Lang, canonical: Set<string>): boolean {
  value = value.trim();
  const call = (lang === "php" ? /^\\?realpath\s*\(/i : /^(?:File\.(?:realpath|expand_path)|Rails\.root\.join|Pathname\.new)\s*\(/).exec(value);
  if (call) {
    const end = pathCallEnd(value, call[0].length - 1);
    if (end < 0) return false;
    const suffix = value.slice(end).trim();
    if (lang === "php") return suffix === "";
    if (call[0].startsWith("File.")) return /^(?:\.to_s)?$/.test(suffix);
    return /^\.(?:realpath|cleanpath|expand_path)(?:\.to_s)?$/.test(suffix);
  }
  return /^(?:\$)?[A-Za-z_]\w*(?:\.to_s)?$/.test(value) && mentions(value, canonical);
}

/** Remove only basename call expressions, retaining any unsanitized suffix. */
function withoutBasenames(text: string, lang: Lang): string {
  const re = lang === "php" ? /(?<![\w>.:])\\?basename\s*\(/gi : /\bFile\.basename\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pathCode(text)))) {
    const end = pathCallEnd(text, re.lastIndex - 1);
    if (end < 0) break;
    text = text.slice(0, match.index) + "0" + text.slice(end);
    re.lastIndex = match.index + 1;
  }
  return text;
}

// Unlike a nested if block, the containing function includes assignments made
// before the guard. A top-level script uses a bounded preceding window.
function pathScopeStart(ctx: Ctx, i: number): number {
  const lower = Math.max(0, i - 80);
  const declaration = ctx.lang === "php" ? /\bfunction\b/ : /^\s*def\s/;
  for (let k = i; k >= lower; k--) {
    if (!declaration.test(ctx.code[k]!)) continue;
    const [, end] = blockOf(ctx, k);
    return end >= i ? k : end + 1;
  }
  return lower;
}

/** Recognise a separator-bounded confinement check on this exact path, before use.
 * This deliberately supports narrow idioms rather than treating any prefix test
 * anywhere in the function as proof. Guarded hits still need reviewer tracing.
 */
function pathGuard(text: string, name: string, lang: Lang, tainted: Set<string>): string | undefined {
  const variable = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const separator = lang === "php" ? "DIRECTORY_SEPARATOR" : "File::SEPARATOR";
  const prefix = `([^()\\n,]+(?:${separator}|["']/["'])\\s*)`;
  let patterns: RegExp[];
  if (lang === "php") {
    const check = `str_starts_with\\s*\\(\\s*${variable}\\s*,\\s*${prefix}\\)`;
    patterns = [
      new RegExp(`if\\s*\\(\\s*!\\s*${check}\\s*\\)\\s*\\{\\s*(?:throw\\b[^;]*;|(?:return|exit|die)\\b[^;]*;)\\s*\\}`),
      new RegExp(`if\\s*\\(\\s*${check}\\s*\\)\\s*\\{[^{}]*$`),
    ];
  } else {
    const check = `${variable}(?:\\.to_s)?\\.start_with\\?\\(\\s*${prefix}\\)`;
    patterns = [
      new RegExp(`(?:^|\\n)\\s*(?:raise|fail|return)\\b[^\\n]*\\bunless\\s+${check}`),
      new RegExp(`unless\\s+${check}\\s*\\n\\s*(?:raise|fail|return)\\b[^\\n]*\\n\\s*end\\b`),
      new RegExp(`(?:^|\\n)\\s*if\\s+${check}\\s*\\n(?:(?!\\b(?:end|else)\\b)[\\s\\S])*$`),
    ];
  }
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && pathCode(text)[match.index + match[0].search(/\S/)]?.trim()
        && !mentions(pathExpression(match[1]!, lang), tainted)) return match[0].trim().slice(0, 80);
  }
  return undefined;
}

function requestPathRule(lang: "php" | "rb"): Rule {
  const source = lang === "php" ? /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\s*\[/ : /\bparams\s*(?:\[|\.fetch\s*\()/;
  const sink = lang === "php"
    ? /\b(?:file_get_contents|readfile)\s*\(|\b(?:include|require)(?:_once)?\b\s*(?:\(|\s)/i
    : /\bFile\.(?:read|binread|open)\s*\(|\bsend_file\b\s*(?:\(|\s)/;
  return {
    id: `${lang}.path.request-path`, cwe: "CWE-22", title: "Filesystem path built from request input",
    confidence: "high", langs: [lang],
    match(ctx) {
      const hits: Hit[] = [];
      ctx.code.forEach((line, i) => {
        const call = sink.exec(pathCode(line));
        if (!call) return;
        const names = new Set<string>();
        const canonical = new Set<string>();
        const writes = new Map<string, { line: number; end: number }>();
        for (let k = pathScopeStart(ctx, i); k <= i; k++) {
          const original = k === i ? ctx.code[k]!.slice(0, call.index) : ctx.code[k]!;
          const code = pathCode(original);
          for (const assignment of code.matchAll(/(?:^|[;\s])((?:\$)?[A-Za-z_]\w*)\s*=(?!=)/g)) {
            const name = assignment[1]!;
            const start = assignment.index! + assignment[0].length;
            const end = code.indexOf(";", start);
            const value = withoutBasenames(original.slice(start, end < 0 ? undefined : end), lang);
            const expression = pathExpression(value, lang);
            const isTainted = source.test(expression) || mentions(expression, names);
            const resolved = resolvedPath(value, lang, canonical);
            if (isTainted) names.add(name); else names.delete(name);
            if (isTainted && resolved) canonical.add(name); else canonical.delete(name);
            writes.set(name, { line: k, end: end < 0 ? original.length : end + 1 });
          }
        }
        const open = call.index + call[0].lastIndexOf("(");
        const end = call[0].endsWith("(") ? pathCallEnd(line, open) : pathCode(line).indexOf(";", call.index);
        const argument = pathExpression(withoutBasenames(line.slice(call.index, end < 0 ? undefined : end), lang), lang);
        const direct = source.test(argument);
        const used = [...names].filter(name => mentions(argument, new Set([name])));
        if (!direct && used.length === 0) return;
        const guards = used.map(name => {
          const write = writes.get(name)!;
          const before = write.line === i ? line.slice(write.end, call.index)
            : [ctx.code[write.line]!.slice(write.end), ...ctx.code.slice(write.line + 1, i), line.slice(0, call.index)].join("\n");
          return canonical.has(name) && pathGuard(before, name, lang, names);
        });
        const guarded = !direct && guards.length > 0 && guards.every(Boolean) ? guards.join("; ") : undefined;
        hits.push({ line: i + 1, ...(guarded ? { guarded } : {}) });
      });
      return hits;
    },
  };
}

export const RULES: Rule[] = [
  // SQL injection
  lineRule({
    id: "js.sql.interpolated-query", cwe: "CWE-89", title: "SQL text built with interpolation or concatenation", confidence: "high", langs: ["js"],
    re: /\.(query|execute|raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe|queryRawUnsafe|executeRawUnsafe|literal)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+\s*[\w$])/,
    needs: (l) => SQL.test(l) || /RawUnsafe|literal/.test(l),
  }),
  lineRule({
    id: "py.sql.formatted-query", cwe: "CWE-89", title: "SQL text built with f-string, % or format", confidence: "high", langs: ["py"],
    re: /\.(execute|executemany|executescript|raw|extra|text)\s*\(\s*(f["']|["'][^"']*["']\s*(%|\.format\(|\+))|\btext\s*\(\s*f["']/,
    needs: (l) => SQL.test(l),
  }),
  lineRule({
    id: "go.sql.sprintf-query", cwe: "CWE-89", title: "SQL text built with fmt.Sprintf or concatenation", confidence: "high", langs: ["go"],
    re: /\.(Query|QueryRow|Exec|QueryContext|QueryRowContext|ExecContext)\s*\([^)]*(fmt\.Sprintf\(|"\s*\+\s*\w)/,
  }),
  lineRule({
    id: "java.sql.concatenated-query", cwe: "CWE-89", title: "SQL/JPQL text concatenated with a variable", confidence: "high", langs: ["java"],
    re: /\.(executeQuery|executeUpdate|execute|prepareStatement|createQuery|createNativeQuery|addBatch)\s*\(\s*"[^"]*"\s*\+/,
    needs: (l) => SQL.test(l),
  }),
  lineRule({
    id: "rb.sql.interpolated-where", cwe: "CWE-89", title: "ActiveRecord SQL fragment with string interpolation", confidence: "high", langs: ["rb"],
    re: /\.(where|order|group|having|joins|find_by_sql|exec_query|execute|pluck|select)\s*\(\s*"[^"]*#\{/,
  }),
  lineRule({
    id: "php.sql.concatenated-query", cwe: "CWE-89", title: "SQL text concatenated with request input", confidence: "high", langs: ["php"],
    re: /(mysqli_query|->query|->exec|DB::(select|statement|raw)|whereRaw|selectRaw|orderByRaw)\s*\([^;]*(\.\s*\$|\$_(GET|POST|REQUEST|COOKIE)|\{\$)/,
  }),
  lineRule({
    id: "js.nosql.operator-injection", cwe: "CWE-943", title: "Query object taken directly from the request", confidence: "medium", langs: ["js"],
    re: /\.(find|findOne|updateOne|updateMany|deleteOne|deleteMany|countDocuments|aggregate)\s*\(\s*req\.(body|query)\b|\$where\s*:/,
  }),

  // Command and code injection
  lineRule({
    id: "py.cmd.shell", cwe: "CWE-78", title: "Shell command built from a non-literal string", confidence: "high", langs: ["py"],
    re: /\b(subprocess\.(run|call|Popen|check_output|check_call|getoutput|getstatusoutput)|os\.system|os\.popen|commands\.getoutput)\s*\(/,
    needs: (l) => (/os\.system|os\.popen|getoutput|getstatusoutput/.test(l) || /shell\s*=\s*True/.test(l)) && /\(\s*(f["']|[A-Za-z_]|["'][^"']*["']\s*(%|\+|\.format))/.test(l.slice(l.indexOf("("))),
  }),
  lineRule({
    id: "js.cmd.exec", cwe: "CWE-78", title: "Shell command string with interpolation or concatenation", confidence: "high", langs: ["js"],
    re: /\b(exec|execSync|spawn|spawnSync)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$]*\s*[,)])/,
    needs: (l) => !/\bexecFile/.test(l) && (!/spawn/.test(l) || /shell\s*:\s*true/.test(l)),
  }),
  lineRule({
    id: "go.cmd.shell", cwe: "CWE-78", title: "exec.Command through a shell with a non-literal script", confidence: "high", langs: ["go"],
    re: /exec\.Command(Context)?\([^)]*"(sh|bash|cmd(\.exe)?)"\s*,\s*"(-c|\/c)"\s*,\s*[^"]/,
  }),
  lineRule({
    id: "rb.cmd.interpolated", cwe: "CWE-78", title: "Shell command with string interpolation", confidence: "high", langs: ["rb"],
    re: /(\bsystem|\bexec|`|%x\(|IO\.popen|Open3\.\w+)\s*\(?\s*"[^"]*#\{|`[^`]*#\{/,
  }),
  lineRule({
    id: "php.cmd.request", cwe: "CWE-78", title: "Shell command with request input", confidence: "high", langs: ["php"],
    re: /\b(shell_exec|system|exec|passthru|popen|proc_open)\s*\([^;]*\$_(GET|POST|REQUEST|COOKIE)/,
  }),
  lineRule({
    id: "js.code.eval", cwe: "CWE-94", title: "Dynamic code evaluation", confidence: "medium", langs: ["js"],
    re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(runIn\w*|compileFunction|Script)\b|setTimeout\s*\(\s*["'`]/,
    unless: /\beval\s*\(\s*["'][^"']*["']\s*\)/,
  }),
  lineRule({
    id: "py.code.eval", cwe: "CWE-94", title: "eval/exec of a non-literal expression", confidence: "medium", langs: ["py"],
    re: /(^|[^.\w])(eval|exec)\s*\(\s*[^"')\s]/,
  }),

  // XSS
  lineRule({
    id: "js.xss.unsafe-html-prop", cwe: "CWE-79", title: "Raw HTML injected into the DOM", confidence: "high", langs: ["js"],
    re: /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:|\bv-html\s*=|\.innerHTML\s*[+]?=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|\{@html\s/,
    unless: /__html\s*:\s*(DOMPurify\.sanitize|sanitize\w*|purify\w*|xss)\s*\(|innerHTML\s*=\s*["'`][^$`]*["'`]\s*;?\s*$|innerHTML\s*=\s*["']{2}/,
  }),
  lineRule({
    id: "js.xss.html-template", cwe: "CWE-79", title: "HTML assembled from a template literal with unescaped values", confidence: "low", langs: ["js"],
    re: /`[^`]*<[a-zA-Z][^`]*\$\{[^`]*`/,
    needs: (l) => {
      const parts = [...l.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);
      return parts.some((p) => !ESCAPED.test(p) && !/^\s*\d+\s*$/.test(p));
    },
    unless: /\b(sql|SQL|query)\s*\(|`\s*(SELECT|INSERT|UPDATE|DELETE)\b/,
  }),
  lineRule({
    id: "py.xss.mark-safe", cwe: "CWE-79", title: "Template output marked safe", confidence: "medium", langs: ["py"],
    re: /\b(mark_safe|Markup|format_html_join)\s*\(\s*(f["']|[A-Za-z_])|\|\s*safe\b|render_template_string\s*\(/,
  }),
  lineRule({
    id: "tpl.xss.raw-output", cwe: "CWE-79", title: "Template raw-output escape hatch", confidence: "medium", langs: "any",
    files: /\.(html|htm|jinja2?|j2|njk|hbs|handlebars|erb|blade\.php|php|twig|vue|svelte)$/,
    re: /\{!!.*!!\}|\|\s*safe\b|\{\{\{[^}]+\}\}\}|<%==|\braw\s*\(|\.html_safe\b|th:utext|\|\s*raw\b/,
  }),
  lineRule({
    id: "rb.xss.html-safe", cwe: "CWE-79", title: "String marked html_safe or raw", confidence: "medium", langs: ["rb"],
    re: /\.html_safe\b|\braw\s*\(?\s*[@\w]/,
  }),

  // SSRF
  taintRule({
    id: "js.ssrf.request-url", cwe: "CWE-918", title: "Outbound request to a URL from the request", confidence: "high", langs: ["js"],
    sink: /\b(fetch|axios(\.(get|post|put|request|head))?|got(\.(get|post))?|request|https?\.(get|request)|needle|superagent\.\w+|undici\.request|ky(\.(get|post))?)\s*\(/,
    source: JS_SOURCE,
    guard: /\b(ALLOWED|ALLOWLIST|allowlist|allowedHosts|isAllowed\w*|WHITELIST|whitelist)\b[^\n]*\.(has|includes|test)\s*\(|\.hostname\s*(===|!==|==|!=)|isPrivate\w*\(|ssrf\w*\(/,
  }),
  taintRule({
    id: "py.ssrf.request-url", cwe: "CWE-918", title: "Outbound request to a URL from the request", confidence: "high", langs: ["py"],
    sink: /\b(requests|httpx|session|client)\.(get|post|put|head|request|stream)\s*\(|\burlopen\s*\(|\burllib\.request\.urlopen\s*\(/,
    source: PY_SOURCE,
    guard: /\b(ALLOWED|ALLOWLIST|allowlist|allowed_hosts|is_allowed\w*)\b[^\n]*\bin\b|\.hostname\s+(not\s+)?in\b|ipaddress\.ip_address\(/,
  }),

  // Path traversal
  taintRule({
    id: "py.path.request-path", cwe: "CWE-22", title: "Filesystem path built from request input", confidence: "high", langs: ["py"],
    sink: /\b(open|send_file|FileResponse|os\.remove|os\.unlink|shutil\.\w+|Path)\s*\(|os\.path\.join\s*\(/,
    source: PY_SOURCE,
    unless: /\bsafe_join\s*\(|secure_filename\s*\(/,
    guard: /\.resolve\(\)\.is_relative_to\(|os\.path\.(realpath|abspath)\([^)]*\)\.startswith\(|commonpath\(/,
  }),
  taintRule({
    id: "js.path.request-path", cwe: "CWE-22", title: "Filesystem path built from request input", confidence: "high", langs: ["js"],
    sink: /\b(readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|rm|rmSync|sendFile|download|path\.(join|resolve))\s*\(/,
    source: JS_SOURCE,
    guard: /\.startsWith\(\s*[\w.]*(ROOT|root|BASE|base|DIR|dir)[\w.]*\s*(\+\s*path\.sep)?\s*\)|\broot\s*:\s*[\w.]+/,
  }),
  requestPathRule("php"),
  requestPathRule("rb"),

  // Deserialization and parsers
  lineRule({
    id: "py.deser.unsafe-loader", cwe: "CWE-502", title: "Deserializer that can construct arbitrary objects", confidence: "high", langs: ["py"],
    re: /\b(pickle|cPickle|_pickle|dill|marshal|shelve|jsonpickle)\.(loads?|Unpickler|decode|open)\s*\(|\byaml\.(load|load_all)\s*\(|\byaml\.unsafe_load/,
    unless: /Loader\s*=\s*(yaml\.)?(SafeLoader|CSafeLoader|BaseLoader)|yaml\.safe_load/,
  }),
  lineRule({
    id: "java.deser.object-input", cwe: "CWE-502", title: "Java native deserialization", confidence: "high", langs: ["java"],
    re: /new\s+ObjectInputStream\s*\(|\.readObject\s*\(\s*\)|XMLDecoder\s*\(|enableDefaultTyping\s*\(|activateDefaultTyping\s*\(/,
  }),
  lineRule({
    id: "php.deser.unserialize", cwe: "CWE-502", title: "unserialize on non-constant data", confidence: "high", langs: ["php"],
    re: /\bunserialize\s*\(\s*\$/,
  }),
  lineRule({
    id: "rb.deser.marshal", cwe: "CWE-502", title: "Marshal/YAML load of non-constant data", confidence: "high", langs: ["rb"],
    re: /\bMarshal\.load\s*\(|\bYAML\.(load|unsafe_load)\s*\(/,
    unless: /permitted_classes|YAML\.safe_load/,
  }),
  lineRule({
    id: "js.deser.node-serialize", cwe: "CWE-502", title: "Deserializer that evaluates functions", confidence: "high", langs: ["js"],
    re: /require\(\s*["'](node-serialize|serialize-to-js|funcster)["']\s*\)|\.unserialize\s*\(/,
  }),
  lineRule({
    id: "js.proto.merge-request", cwe: "CWE-1321", title: "Deep merge of request data into an object", confidence: "medium", langs: ["js"],
    re: /\b(merge|defaultsDeep|mergeWith|extend|set|assignIn|deepmerge)\s*\([^)]*req\.(body|query)/,
  }),

  // AuthN / sessions / crypto
  lineRule({
    id: "js.jwt.decode-unverified", cwe: "CWE-347", title: "JWT claims read without signature verification", confidence: "high", langs: ["js"],
    re: /\bjwt\.decode\s*\(|\bjwtDecode\s*\(|algorithms\s*:\s*\[[^\]]*["']none["']/,
  }),
  lineRule({
    id: "py.jwt.verify-disabled", cwe: "CWE-347", title: "JWT signature verification disabled", confidence: "high", langs: ["py"],
    re: /verify_signature["']?\s*:\s*False|jwt\.decode\([^)]*verify\s*=\s*False|algorithms\s*=\s*\[[^\]]*["']none["']/,
  }),
  lineRule({
    id: "any.tls.verification-disabled", cwe: "CWE-295", title: "TLS certificate verification disabled", confidence: "high", langs: "any",
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=?\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|CERT_NONE|setHostnameVerifier\s*\(\s*\(?[^)]*\)?\s*->\s*true|curl_setopt\([^)]*CURLOPT_SSL_VERIFYPEER\s*,\s*(0|false)/,
  }),
  lineRule({
    id: "any.crypto.weak-random-token", cwe: "CWE-330", title: "Non-cryptographic randomness for a secret value", confidence: "medium", langs: "any",
    re: /Math\.random\s*\(|\brandom\.(random|randint|choice|choices|getrandbits)\s*\(|\brand\s*\(|math\/rand"/,
    needs: (l) => /token|secret|password|passwd|nonce|otp|salt|reset|session|api_?key|invite|code/i.test(l),
  }),
  lineRule({
    id: "any.crypto.weak-algorithm", cwe: "CWE-327", title: "Weak hash or cipher for a security purpose", confidence: "low", langs: "any",
    re: /createHash\s*\(\s*["'](md5|sha1)["']|hashlib\.(md5|sha1)\s*\(|\bMD5\.Create|DigestUtils\.(md5|sha1)|createCipheriv?\s*\(\s*["'][^"']*(ecb|des|rc4)|\bAES\.MODE_ECB|Cipher\.getInstance\s*\(\s*"[^"]*(ECB|DES)/i,
    needs: (l) => /pass|token|sign|secret|auth|crypt|cipher|ecb|des/i.test(l),
  }),
  lineRule({
    id: "js.cookie.insecure-session", cwe: "CWE-614", title: "Session cookie without secure/httpOnly", confidence: "low", langs: ["js"],
    re: /(httpOnly|secure)\s*:\s*false/,
  }),

  // Redirects
  taintRule({
    id: "js.redirect.request-target", cwe: "CWE-601", title: "Redirect to a target taken from the request", confidence: "medium", langs: ["js"],
    sink: /\b(res\.redirect|redirect|NextResponse\.redirect|ctx\.redirect)\s*\(/,
    source: JS_SOURCE,
    guard: /startsWith\(\s*["']\/["']\s*\)\s*&&\s*!\s*[\w.]+\.startsWith\(\s*["']\/\/["']|new URL\([^)]*\)\.origin\s*(===|!==)|ALLOWED|allowlist/,
  }),
  taintRule({
    id: "py.redirect.request-target", cwe: "CWE-601", title: "Redirect to a target taken from the request", confidence: "medium", langs: ["py"],
    sink: /\b(redirect|HttpResponseRedirect|RedirectResponse)\s*\(/,
    source: PY_SOURCE,
    guard: /url_has_allowed_host_and_scheme|is_safe_url|urlparse\([^)]*\)\.netloc/,
  }),

  // Access control heuristic: object loaded by id with no owner/tenant reference in the handler.
  {
    id: "any.authz.object-by-id-unscoped", cwe: "CWE-639", title: "Object loaded by id with no owner/tenant check in the handler", confidence: "low", langs: ["py", "js", "rb", "php", "java", "go"],
    match(ctx) {
      const lookup = /\b(get_or_404|get_object_or_404|first_or_404|findById|findByPk|findUnique|findOneBy|findOrFail|find_by_id|find\(\s*params\[|\.get\(\s*(id|pk)\s*=|\.query\.get\(|getById|findByIdOrThrow)\b|\b\w+\.find\(\s*params\[:id\]/;
      const scoped = /\b(owner|owner_id|ownerId|user_id|userId|tenant|tenant_id|tenantId|org_id|orgId|organization|account_id|accountId|team_id|teamId|workspace|current_user|currentUser|g\.user|req\.user|request\.user|session\[|authorize|can\?|policy|Policy|permission|has_perm|abort\(\s*40[34]\s*\)|forbidden|Forbidden)\b/;
      const route = /@\w+\.(route|get|post|put|patch|delete)\(|\b(router|app|server)\.(get|post|put|patch|delete|all)\(|@(Get|Post|Put|Patch|Delete|Request)Mapping|\bdef\s+(show|update|destroy|edit)\b|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/;
      const hits: Hit[] = [];
      ctx.code.forEach((l, i) => {
        if (!lookup.test(l)) return;
        const [s, e] = blockOf(ctx, i);
        const block = ctx.code.slice(s, e + 1).join("\n");
        if (!route.test(block) || scoped.test(block)) return;
        hits.push({ line: i + 1, note: "No owner/tenant/policy reference in this handler; trace whether a query scope or middleware applies." });
      });
      return hits;
    },
  },

  // Secrets: scanned on raw lines, values are never printed.
  lineRule({
    id: "any.secret.credential-literal", cwe: "CWE-798", title: "Credential with a known provider format in source", confidence: "high", langs: "any", raw: true,
    re: /\b(sk|rk)_live_[0-9A-Za-z]{16,}|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{35}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(proj-)?[A-Za-z0-9_-]{32,}|\bnpm_[A-Za-z0-9]{36}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  }),

  // CI / supply chain (GitHub Actions)
  {
    id: "gha.pwn-request", cwe: "CWE-829", title: "pull_request_target runs code from the pull request", confidence: "high", langs: ["yaml"], files: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
    match(ctx) {
      const text = ctx.code.join("\n");
      if (!/\bpull_request_target\b|\bworkflow_run\b/.test(text)) return [];
      return ctx.code.flatMap((l, i) =>
        /ref\s*:\s*\$\{\{\s*github\.(event\.pull_request\.head\.(sha|ref)|head_ref)|ref\s*:\s*refs\/pull\/|github\.event\.workflow_run\.head_(sha|branch)/.test(l) ? [{ line: i + 1 }] : []);
    },
  },
  lineRule({
    id: "gha.script-injection", cwe: "CWE-94", title: "Untrusted event text expanded inside a run script", confidence: "high", langs: ["yaml"], files: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
    re: /\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages)\b[^}]*\.(title|body|name|message|label|ref|email|default_branch|page_name)|head_ref)\b[^}]*\}\}/,
    needs: (l, ctx, i) => {
      for (let k = i; k >= Math.max(0, i - 15); k--) {
        if (/^\s*-?\s*run\s*:/.test(ctx.code[k]!)) return true;
        if (/^\s*-?\s*(uses|with|env|if)\s*:/.test(ctx.code[k]!)) return false;
      }
      return false;
    },
  }),
  lineRule({
    id: "gha.permissions-write-all", cwe: "CWE-250", title: "Workflow token granted write-all", confidence: "medium", langs: ["yaml"], files: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/,
    re: /^\s*permissions\s*:\s*write-all\s*$/,
  }),
];
