# Abliterate

**A security review before you push, inside the coding agent you already use.** Abliterate follows a change from the actor who can reach it to the data it exposes or the action it takes. You get findings tied to a file, a line and a Git snapshot, a proposed fix, and a regression test. If a control lives outside the repository, the review says precisely what is unknown.

[Install](#install) · [Try a review](#try-a-review) · [Prompt catalog](#choose-a-prompt) · [Evaluation cases](verification/README.md) · [MIT](LICENSE)

## Install

From your project, using the [Agent Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add andreaborio/abliterate --skill abliterate-review
```

Select your agent and project scope. For an installation without a package manager, download the [versioned skill file](https://github.com/andreaborio/abliterate/blob/v0.1.0/skills/abliterate-review/SKILL.md) and save it as `.agents/skills/abliterate-review/SKILL.md` for Codex or `.claude/skills/abliterate-review/SKILL.md` for Claude Code. Open a new session in that project.

## Try a review

> Use abliterate-review before I push to main. Tell me what is in the commits, which local fixes are still uncommitted, and what test would catch each confirmed regression. Leave my files unchanged.

For a fix: **“Fix the confirmed directory disclosure. Test the private field is absent and the display name is still visible.”** For a feature that does not exist yet: **“Design the access rules for a shared invoice. Which roles and tests do we need before writing the endpoint?”**

**Example from a synthetic review:** a team directory promises to return a display name. The commit also returns salary. The file on disk looks fixed, but the fix is only staged: pushing now still publishes the affected commit. The review points to the committed serializer and proposes checking the complete returned object. It does not claim an HTTP disclosure without a route that reaches the serializer.

## Choose a prompt

| Topic | Question the review answers |
| --- | --- |
| `design` | What rule should hold, where is it enforced, and how would we test it? |
| `review` | What regression is in the actual push, the index or the working tree? |
| `access` | Which actors may act on this specific resource, including legitimate collaborators? |
| `inputs` | Did an existing or new value reach a different execution or rendering context? |
| `privacy` | Does a private field cross into a response, cache, error message or log? |
| `state` | Does the invariant survive retries, revocation or work handed to a job? |
| `delivery` | Does a dependency or CI change execute with more trust than intended? |
| `fix` | Does a focused test fail before the fix and pass afterward, without breaking allowed use? |

## Terminal packages

The [GitHub release](https://github.com/andreaborio/abliterate/releases/tag/v0.1.0) contains the npm archive, Python wheel, source distribution and checksums. Install **one** of the two CLIs: they expose the same command. With the relevant release file in your current folder:

```sh
npm install --global ./abliterate-0.1.0.tgz
# or, in a Python environment:
python -m pip install ./abliterate-0.1.0-py3-none-any.whl
```

```sh
abliterate prompt
abliterate review --since main
abliterate prompt access
```

Paste the brief into your agent. The CLI itself **prints instructions**: it does not scan the repo, change files, contact a model or gate CI. The agent needs access to the sources; its own data and execution policies apply. The supplied prompts are in Italian and the agent replies in your language.

## Development

The source of truth is [SKILL.md](skills/abliterate-review/SKILL.md). Small Node and Python entry points in [packages](packages) expose that same text without runtime dependencies. To build and check in a fresh clone, use Python 3.11+, Node 18+, npm, Git and uv 0.11.16:

```sh
python3 build.py
python3 verification/check_release.py
```

The checks install both **built packages** in temporary directories and compare their output. [Behavioral cases](verification/README.md) test the reviewer’s decisions separately. See [contributing](CONTRIBUTING.md) or the [security policy](SECURITY.md).
