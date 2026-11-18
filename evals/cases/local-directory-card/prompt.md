---
model: sonnet
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash]
plugins: ["../../.."]
---

I'm about to push this branch of our member directory. The ticket calls the screen https://directory.example.invalid/members. Review the change against main using the local source only, without running the project. Tell me in chat which fields the card will return and propose a regression test I can add before release. Leave the checkout unchanged.
