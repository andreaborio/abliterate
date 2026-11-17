// Bundles the engine into one dependency-free CommonJS file for the npm package.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../packages/npm/package.json", import.meta.url)));

await build({
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
