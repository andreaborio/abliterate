import { report, REPORT_HELP } from "./commands/report";
import { EXIT, parseArgs, UsageError, VERSION } from "./util";

type Command = { help: string; booleans?: string[]; run: (flags: ReturnType<typeof parseArgs>, cwd: string) => number | Promise<number> };

const commands: Record<string, Command> = {
  report: { help: REPORT_HELP, booleans: ["include-unconfirmed"], run: report },
};

const HELP = `abliterate ${VERSION}: evidence for a security review of source code.

Commands:
${Object.values(commands).map((c) => "  " + c.help.split("\n")[0]).join("\n")}

Read-only on your repository. Only "deps" uses the network, and it sends package names
and versions, never source. Run "abliterate <command> --help" for details.`;

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "-h" || name === "--help") { process.stdout.write(HELP + "\n"); return EXIT.ok; }
  if (name === "--version") { process.stdout.write(VERSION + "\n"); return EXIT.ok; }
  const cmd = commands[name];
  if (!cmd) throw new UsageError(`unknown command "${name}"`);
  if (rest.includes("--help") || rest.includes("-h")) { process.stdout.write(cmd.help + "\n"); return EXIT.ok; }
  return cmd.run(parseArgs(rest, cmd.booleans), process.cwd());
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`abliterate: ${err.message}\nRun "abliterate --help".\n`);
      process.exitCode = EXIT.usage;
    } else {
      process.stderr.write(`abliterate: ${(err as Error).message}\n`);
      process.exitCode = EXIT.env;
    }
  },
);
