// Bundles the engine into one dependency-free CommonJS file for the npm package, and copies it
// to bin/abliterate: Claude Code puts a plugin's bin/ on PATH, so the plugin works without npm.
import { build } from "esbuild";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve everything from this file so the build works from any working directory (CI, the Action).
const here = fileURLToPath(new URL(".", import.meta.url));

const pkg = JSON.parse(readFileSync(new URL("../packages/npm/package.json", import.meta.url)));

await build({
  absWorkingDir: here,
  entryPoints: ["src/cli.ts"],
  outfile: "../packages/npm/cli.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});

copyFileSync(new URL("../packages/npm/cli.cjs", import.meta.url), new URL("../bin/abliterate", import.meta.url));
chmodSync(new URL("../bin/abliterate", import.meta.url), 0o755);
