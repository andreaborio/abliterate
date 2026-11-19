---
model: sonnet
max_turns: 60
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git rev-parse:*)"]
plugins: ["../../.."]
---

Review what this branch would push against main for security problems, especially who can read which invoice. Give me the findings in your reply.
