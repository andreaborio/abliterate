"""Print the bundled skills and prompts. No network or repository access.

The analysis engine (scope, surface, sinks, deps, variants, report, hook) ships in the npm
package. This module mirrors the npm CLI's skill/prompt/review output byte for byte.
"""
import re
import sys
from importlib.metadata import version
from importlib.resources import files

SKILLS = ("abliterate-review", "abliterate-variants")
ENGINE = ("scope", "surface", "sinks", "deps", "variants", "draft", "report", "hook")
SAFE_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,199}")


class Usage(Exception):
    pass


def read(*parts):
    return files("abliterate").joinpath("skills", *parts).read_text(encoding="utf-8")


def topics():
    scope = read("abliterate-review", "reference", "review-scope.md").strip()
    out = {}
    for block in re.split(r"\n(?=### )", read("abliterate-review", "reference", "prompts.md"))[1:]:
        heading, _, rest = block.partition("\n")
        m = re.fullmatch(r"### (\w+) — (.+)", heading.strip())
        if m:
            out[m.group(1)] = (m.group(2), scope + "\n\n" + rest.strip())
    return out


def safe_ref(ref):
    if not SAFE_REF.fullmatch(ref) or ".." in ref:
        raise Usage(f"unsafe git ref: {ref}")
    return ref


def parse(args):
    """Same rules as the npm CLI: --key value or --key=value; positional arguments otherwise."""
    flags, positional, i = {}, [], 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional += args[i + 1:]
            break
        if a.startswith("--"):
            key, eq, val = a[2:].partition("=")
            if not eq:
                i += 1
                if i >= len(args):
                    raise Usage(f"--{key} needs a value")
                val = args[i]
            flags[key] = val
        else:
            positional.append(a)
        i += 1
    return flags, positional


def only(flags, allowed):
    for k in flags:
        if k not in allowed:
            raise Usage(f"unknown option --{k}")


def run(argv):
    name, rest = (argv[0], argv[1:]) if argv else (None, [])
    if name in (None, "-h", "--help"):
        sys.stdout.write("abliterate (Python): skill, prompt and review only.\n"
                         "The analysis engine is in the npm package: npx -y abliterate@" + version("abliterate") + " --help\n")
        return 0
    if name == "--version":
        sys.stdout.write(version("abliterate") + "\n")
        return 0
    if name in ENGINE:
        raise Usage(f'"{name}" is part of the npm package: npx -y abliterate@{version("abliterate")} {name}')
    if name not in ("skill", "prompt", "review"):
        raise Usage(f'unknown command "{name}"')
    flags, positional = parse(rest)
    if name == "skill":
        only(flags, [])
        skill = positional[0] if positional else "abliterate-review"
        if skill not in SKILLS:
            raise Usage("skill name must be abliterate-review or abliterate-variants")
        sys.stdout.write(read(skill, "SKILL.md"))
    elif name == "prompt":
        only(flags, [])
        all_topics = topics()
        if not positional:
            lines = [f"  {k.ljust(9)} {title}" for k, (title, _) in all_topics.items()]
            sys.stdout.write("Pick a prompt: abliterate prompt TOPIC\n" + "\n".join(lines) + "\n")
            return 0
        if positional[0] not in all_topics:
            raise Usage(f'unknown topic "{positional[0]}"; topics: {", ".join(all_topics)}')
        body = all_topics[positional[0]][1]
        sys.stdout.write(body.replace("{base}", "the base branch").replace("{seed}", "the fix or advisory I name") + "\n")
    else:
        only(flags, ["since"])
        since = flags.get("since")
        if since is not None:
            safe_ref(since)
        body = topics()["review"][1]
        sys.stdout.write(body.replace("{base}", f"`{since}`" if since else "the base branch").replace("{seed}", "") + "\n")
    return 0


def main():
    try:
        return run(sys.argv[1:])
    except Usage as err:
        sys.stderr.write(f"abliterate: {err}\nRun \"abliterate --help\".\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
