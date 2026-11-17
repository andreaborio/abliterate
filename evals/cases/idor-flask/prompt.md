---
model: sonnet
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write]
plugins: ["../../.."]
---

Review what this branch would push against main for security problems, especially who can read which invoice. Write your findings to findings.json in the repository root and give me a short summary.
