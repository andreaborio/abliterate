#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const help = "abliterate skill | prompt [design|review|access|inputs|privacy|state|delivery|fix] | review [--since BRANCH]\nStampa istruzioni per il tuo agente; la CLI non analizza il repository.";
const skill = fs.readFileSync(path.join(__dirname, "SKILL.md"), "utf8");
const body = skill.replace(/^---\n[\s\S]*?\n---\n+/, "");
const [rules, catalog] = body.split("## Prompt da usare nell’agente\n");
const topics = Object.fromEntries(catalog.trim().split(/\n(?=### )/).map(block => {
  const [heading, ...lines] = block.split("\n");
  return [heading.split(" ")[1], lines.join("\n").trim()];
}));
const index = ["Scegli un prompt: abliterate prompt TEMA", ...catalog.split("\n").filter(l => l.startsWith("### ")).map(l => l.slice(4))].join("\n");
function fail() { console.error(help); process.exitCode = 2; }
function brief(topic, base) {
  return ["Istruzioni per l’agente · Abliterate", rules.trim(), topics[topic], base && "Base Git richiesta: " + base].filter(Boolean).join("\n\n");
}
if (!args.length || (args.length === 1 && ["-h","--help"].includes(args[0]))) console.log(help);
else if (args.length === 1 && args[0] === "--version") console.log(require("./package.json").version);
else if (args.length === 1 && args[0] === "skill") process.stdout.write(skill);
else if (args[0] === "prompt" && args.length === 1) console.log(index);
else if (args[0] === "prompt" && args.length === 2 && Object.hasOwn(topics, args[1])) console.log(brief(args[1]));
else if (args[0] === "review" && (args.length === 1 || (args.length === 3 && args[1] === "--since" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(args[2])))) console.log(brief("review", args[2]));
else fail();
