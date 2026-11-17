import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lookup, priority } from "../deps/advisories";
import { isLockfile, parseLockfile, type Dep } from "../deps/lockfiles";
import { makeHttp } from "../deps/net";
import { reachability } from "../deps/reachability";
import { computeScope, trackedFiles } from "../git";
import { skipPath } from "../lang";
import { allowFlags, EXIT, git, print, str, UsageError, type Flags } from "../util";

export const DEPS_HELP = `abliterate deps [--base REF] [--offline] [--changed] [--inventory] [--format json|md]
  Resolved dependencies from lockfiles → known vulnerabilities (OSV), CISA KEV, EPSS, and a
  reachability hint (is the package imported, is the named function called). Marks dependencies
  the change introduced or bumped. Sends only package names and versions; --offline uses the cache.
  --inventory lists the resolved packages and exits without any network access.`;

export async function deps(flags: Flags, cwd: string): Promise<number> {
  allowFlags(flags, ["base", "offline", "changed", "inventory", "format"]);
  const format = str(flags, "format") ?? "json";
  if (format !== "json" && format !== "md") throw new UsageError("--format must be json or md");
  const sc = computeScope(cwd, str(flags, "base"));
  const all = [...new Set([...trackedFiles(sc.root), ...sc.untracked])];
  const lockfiles = all.filter((p) => isLockfile(p) && !skipPath(p.replace(/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/, "x")));

  const notes = [...sc.notes];
  const current: Dep[] = [];
  const before = new Set<string>();
  for (const file of lockfiles) {
    try { current.push(...parseLockfile(file, readFileSync(join(sc.root, file), "utf8"))); }
    catch (err) { notes.push(`Could not parse ${file}: ${(err as Error).message}`); }
    if (sc.mergeBase) {
      const old = git(sc.root, ["cat-file", "-p", `${sc.mergeBase}:${file}`], { allowFail: true });
      if (old) try { for (const d of parseLockfile(file, old)) before.add(`${d.ecosystem}|${d.name}|${d.version}`); } catch { /* old lockfile unreadable: treat all as new */ }
    }
  }
  const introduced = (d: Dep) => !!sc.mergeBase && !before.has(`${d.ecosystem}|${d.name}|${d.version}`);
  const scoped = flags.changed === true ? current.filter(introduced) : current;

  if (flags.inventory === true) {
    print({ lockfiles, packages: scoped.map((d) => ({ ...d, introduced: introduced(d) })), notes });
    return EXIT.ok;
  }
  const http = makeHttp(flags.offline === true);
  const { results, checked, complete } = await lookup(scoped, http);
  if (http.failures.length) notes.push(...[...new Set(http.failures)].map((f) => `Network: ${f}`));
  if (!complete) notes.push(flags.offline === true ? "Offline: some packages or advisories were not in the cache and were not checked." : "Some lookups failed: results are incomplete.");

  const vulnerable = [...results.entries()].map(([d, advisories]) => {
    const symbols = [...new Set(advisories.flatMap((a) => a.symbols))];
    const reach = reachability(sc.root, all, d.ecosystem, d.name, symbols);
    return {
      ecosystem: d.ecosystem, package: d.name, version: d.version, file: d.file, line: d.line,
      introduced: introduced(d),
      imports: reach.imports,
      // Reachability is judged per advisory: only the symbols that advisory names count.
      advisories: advisories.sort((a, b) => priority(b) - priority(a)).map((a) => {
        const uses = reach.symbolUses.filter((u) => a.symbols.includes(u.symbol));
        const verdict = reach.verdict === "unknown" ? "unknown" : uses.length ? "symbol-used" : reach.imports.length ? (a.symbols.length ? "imported-symbol-not-seen" : "imported") : "not-imported";
        return { ...a, reachability: { verdict, symbolUses: uses } };
      }),
    };
  }).sort((a, b) => Number(b.introduced) - Number(a.introduced) || priority(b.advisories[0]!) - priority(a.advisories[0]!));

  const out = {
    base: sc.base ?? null, mergeBase: sc.mergeBase ?? null, lockfiles, packages: current.length, checked, complete,
    vulnerable, notes,
    guidance: "Confirm only what the code reaches: a vulnerable function called with data an attacker controls. KEV-listed advisories outrank EPSS, which outranks CVSS. Unreached advisories are upgrade hygiene, not findings.",
  };
  if (format === "md") {
    const rows = vulnerable.flatMap((v) => v.advisories.map((a) =>
      `| ${v.introduced ? "yes" : ""} | ${v.package}@${v.version} | ${a.id}${a.aliases[0] ? ` (${a.aliases.find((x) => x.startsWith("CVE-")) ?? a.aliases[0]})` : ""} | ${a.severity ?? "?"} | ${a.kev ? "**KEV**" : ""} | ${a.epss !== undefined ? a.epss.toFixed(3) : ""} | ${a.fixed ?? ""} | ${a.reachability.verdict} | ${a.summary.replace(/\|/g, "/")} |`));
    process.stdout.write([`${current.length} packages in ${lockfiles.length} lockfile(s); ${checked} checked.${complete ? "" : " **Incomplete.**"}`, "",
      "| introduced | package | advisory | severity | KEV | EPSS | fixed in | reachability | summary |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", ...rows,
      ...notes.map((n) => `\n> ${n}`)].join("\n") + "\n");
  } else print(out);
  return EXIT.ok;
}
