import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeRef, UsageError, EXIT, type Flags, allowFlags, str } from "../util";

// Skill files: next to cli.cjs in the npm package (skills/), one level up from the plugin's
// bin/abliterate (repo root skills/), or two levels up from packages/npm in a checkout.
const skillRoot = () => {
  for (const dir of [join(__dirname, "skills"), join(__dirname, "..", "skills"), join(__dirname, "..", "..", "skills")]) if (existsSync(join(dir, "abliterate-review", "SKILL.md"))) return dir;
  throw new Error("bundled skill files not found next to the CLI");
};

const read = (...parts: string[]) => readFileSync(join(skillRoot(), ...parts), "utf8");

export const reviewScope = () => read("abliterate-review", "reference", "review-scope.md").trim();

function topics(): Map<string, { title: string; body: string }> {
  const scope = reviewScope();
  const text = read("abliterate-review", "reference", "prompts.md");
  const out = new Map<string, { title: string; body: string }>();
  for (const block of text.split(/\n(?=### )/).slice(1)) {
    const [heading, ...rest] = block.split("\n");
    const m = /^### (\w+) — (.+)$/.exec(heading!.trim());
    if (m) out.set(m[1]!, { title: m[2]!, body: scope + "\n\n" + rest.join("\n").trim() });
  }
  return out;
}

export const SKILL_HELP = `abliterate skill [abliterate-review|abliterate-variants]
  Prints a bundled SKILL.md (default abliterate-review).`;
export const PROMPT_HELP = `abliterate prompt [TOPIC]
  Lists the focused prompts, or prints one to paste into your agent.`;
export const REVIEW_HELP = `abliterate review [--since BRANCH]
  Prints the pre-push review prompt for your agent, with the base filled in.`;

export function skill(flags: Flags): number {
  allowFlags(flags, []);
  const name = flags._[0] ?? "abliterate-review";
  if (!["abliterate-review", "abliterate-variants"].includes(name)) throw new UsageError("skill name must be abliterate-review or abliterate-variants");
  process.stdout.write(read(name, "SKILL.md"));
  return EXIT.ok;
}

export function prompt(flags: Flags): number {
  allowFlags(flags, []);
  const all = topics();
  const name = flags._[0];
  if (!name) {
    process.stdout.write(`Pick a prompt: abliterate prompt TOPIC\n${[...all].map(([k, v]) => `  ${k.padEnd(9)} ${v.title}`).join("\n")}\n`);
    return EXIT.ok;
  }
  const t = all.get(name);
  if (!t) throw new UsageError(`unknown topic "${name}"; topics: ${[...all.keys()].join(", ")}`);
  process.stdout.write(t.body.replace(/\{base\}/g, "the base branch").replace(/\{seed\}/g, "the fix or advisory I name") + "\n");
  return EXIT.ok;
}

export function review(flags: Flags): number {
  allowFlags(flags, ["since"]);
  const since = str(flags, "since");
  if (since) safeRef(since);
  const t = topics().get("review")!;
  process.stdout.write(t.body.replace(/\{base\}/g, since ? `\`${since}\`` : "the base branch").replace(/\{seed\}/g, "") + "\n");
  return EXIT.ok;
}
