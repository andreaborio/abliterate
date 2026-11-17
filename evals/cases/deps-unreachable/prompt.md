---
model: sonnet
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write]
plugins: ["../../.."]
---

Review this branch against main, including the dependency it adds. Write your findings to findings.json in the repository root and give me a short summary.
