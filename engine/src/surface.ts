import { langOf, skipPath, stripComments } from "./lang";

export interface EntryPoint {
  kind: "http" | "server-action" | "job" | "webhook" | "ci-trigger" | "cli";
  framework: string;
  method?: string;
  route?: string;
  path: string;
  line: number;
  /** Auth/authorization names seen on the declaration (decorators, middleware arguments). */
  guards: string[];
}

const GUARD_NAME = /\b(login_required|permission_required|user_passes_test|staff_member_required|requires_auth|auth\w*|authenticate\w*|authorize\w*|require\w*(Auth|User|Admin|Role|Login|Permission)\w*|isAuthenticated|ensureLoggedIn|protect\w*|verify\w*Token|jwtCheck|passport\.authenticate|Depends\(\s*get_current\w*|Depends\(\s*\w*(auth|user)\w*|PreAuthorize|Secured|RolesAllowed|before_action\s+:authenticate\w*|middleware\(\s*['"]auth[\w:'",\s]*\)|can\(|policy|Policy|current_user)\b/g;

const guardsIn = (text: string) => [...new Set(text.match(GUARD_NAME) ?? [])].slice(0, 6);

export function entryPoints(path: string, text: string): EntryPoint[] {
  if (skipPath(path)) return [];
  const lang = langOf(path);
  const lines = stripComments(text, lang).split(/\r?\n/);
  const out: EntryPoint[] = [];
  const push = (e: Omit<EntryPoint, "path">) => out.push({ path, ...e });

  if (lang === "js") {
    const nextRoute = /(^|\/)(app|src\/app)\/(.+)\/route\.(t|j)sx?$/.exec(path);
    const pagesApi = /(^|\/)(pages|src\/pages)\/api\/(.+)\.(t|j)sx?$/.exec(path);
    lines.forEach((l, i) => {
      const express = /\b(app|router|server|api|routes?|fastify|r)\.(get|post|put|patch|delete|all|options|head)\s*\(\s*(['"`])([^'"`]+)\3([^;]*)/.exec(l);
      if (express) push({ kind: "http", framework: "express-like", method: express[2]!.toUpperCase(), route: express[4], line: i + 1, guards: guardsIn(express[5]!) });
      if (nextRoute) {
        const m = /export\s+(async\s+)?(function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(l);
        if (m) push({ kind: "http", framework: "next-app-router", method: m[3], route: "/" + nextRoute[3]!.replace(/\(([^)]+)\)\//g, ""), line: i + 1, guards: guardsIn(lines.slice(i, i + 15).join("\n")) });
      }
      if (pagesApi && /export\s+default\b/.test(l)) push({ kind: "http", framework: "next-pages-api", route: "/api/" + pagesApi[3], line: i + 1, guards: guardsIn(lines.slice(i, i + 15).join("\n")) });
      if (/^\s*["']use server["']/.test(l)) push({ kind: "server-action", framework: "next-server-action", line: i + 1, guards: guardsIn(lines.slice(i, i + 40).join("\n")) });
      const q = /\bnew\s+Worker\s*\(\s*['"`]([^'"`]+)|\.process\s*\(\s*['"`]([^'"`]+)|cron\.schedule\s*\(/.exec(l);
      if (q) push({ kind: "job", framework: "queue/cron", route: q[1] ?? q[2], line: i + 1, guards: [] });
      if (/webhook/i.test(l) && express) out[out.length - 1]!.kind = "webhook";
    });
  } else if (lang === "py") {
    lines.forEach((l, i) => {
      const flask = /@\s*(\w+)\.(route|get|post|put|patch|delete|api_route|websocket)\s*\(\s*["']([^"']+)["']([^\n]*)/.exec(l);
      if (flask) {
        const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(flask[4]!)?.[1]?.replace(/["'\s]/g, "");
        // Decorators and the signature that follow apply to this route.
        let k = i + 1;
        const decl: string[] = [l];
        while (k < lines.length && k < i + 12) { decl.push(lines[k]!); if (/^\s*(async\s+)?def\s/.test(lines[k]!)) { decl.push(lines[k + 1] ?? ""); break; } k++; }
        const method = flask[2] === "route" ? methods ?? "GET" : flask[2]!.toUpperCase();
        push({ kind: "http", framework: /Depends|APIRouter|FastAPI/.test(text) ? "fastapi" : "flask", method, route: flask[3], line: i + 1, guards: guardsIn(decl.join("\n")) });
      }
      const django = /\b(re_)?path\s*\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/.exec(l);
      if (django && /urls\.py$/.test(path)) push({ kind: "http", framework: "django", route: "/" + django[2], line: i + 1, guards: guardsIn(l) });
      if (/@(shared_task|app\.task|celery\.task|dramatiq\.actor)\b/.test(l)) push({ kind: "job", framework: "celery/dramatiq", line: i + 1, guards: [] });
    });
  } else if (lang === "java") {
    lines.forEach((l, i) => {
      const m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(\(\s*(value\s*=\s*)?\{?\s*"([^"]*)")?/.exec(l);
      if (m) push({ kind: "http", framework: "spring", method: m[1] === "Request" ? undefined : m[1]!.toUpperCase(), route: m[4], line: i + 1, guards: guardsIn(lines.slice(Math.max(0, i - 4), i + 1).join("\n")) });
    });
  } else if (lang === "go") {
    lines.forEach((l, i) => {
      const m = /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any)\s*\(\s*"([^"]+)"([^\n]*)/.exec(l);
      if (m) push({ kind: "http", framework: "go-http", method: /Handle/.test(m[1]!) ? undefined : m[1]!.toUpperCase(), route: m[2], line: i + 1, guards: guardsIn(m[3]!) });
    });
  } else if (lang === "rb" && /config\/routes\.rb$/.test(path)) {
    lines.forEach((l, i) => {
      const m = /^\s*(get|post|put|patch|delete|resources?|match)\s+["':]?([\w/:.-]+)/.exec(l);
      if (m) push({ kind: "http", framework: "rails", method: /^(get|post|put|patch|delete)$/.test(m[1]!) ? m[1]!.toUpperCase() : undefined, route: m[2], line: i + 1, guards: [] });
    });
  } else if (lang === "php") {
    lines.forEach((l, i) => {
      const m = /Route::(get|post|put|patch|delete|any|match|resource|apiResource)\s*\(\s*['"]([^'"]+)['"]([^;]*)/.exec(l);
      if (m) push({ kind: "http", framework: "laravel", method: m[1]!.toUpperCase(), route: m[2], line: i + 1, guards: guardsIn(m[3]!) });
    });
  } else if (lang === "yaml" && /(^|\/)\.github\/workflows\//.test(path)) {
    lines.forEach((l, i) => {
      const m = /^\s*(-\s*)?(pull_request_target|pull_request|push|workflow_run|issue_comment|issues|workflow_dispatch|schedule|release|discussion_comment|pull_request_review_comment)\s*:?\s*$|^\s*on\s*:\s*\[?([\w, ]+)\]?\s*$/.exec(l);
      if (m) push({ kind: "ci-trigger", framework: "github-actions", route: m[2] ?? m[3]?.trim(), line: i + 1, guards: [] });
    });
  }
  return out;
}
