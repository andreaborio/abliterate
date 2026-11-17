# abliterate

Eight prompts for a security review before you push. The CLI prints a brief for your coding agent; it never reads your repository, runs its code, or sends it anywhere. The agent performs the review under its own permissions. Prompts are in Italian; the skill asks the agent to reply in your language.

```sh
abliterate prompt                    # list topics
abliterate review --since main       # print a pre-push review brief
abliterate prompt privacy            # focus on response fields, caches and logs
abliterate skill                     # export the complete SKILL.md
```

Pick **either** the Node or Python distribution: both install the same command. Use the output from your coding agent in the repository you want reviewed. For direct skill installation, examples and reproducible tests, see [andreaborio/abliterate](https://github.com/andreaborio/abliterate). MIT license.
