"""Print the review skill or a focused prompt. No network or repository access."""
import re
import sys
from importlib.metadata import version
from importlib.resources import files

HELP = ("abliterate skill | prompt [design|review|access|inputs|privacy|state|delivery|fix] | review [--since BRANCH]\n"
        "Stampa istruzioni per il tuo agente; la CLI non analizza il repository.")


def main():
    args = sys.argv[1:]
    skill = files("abliterate").joinpath("SKILL.md").read_text(encoding="utf-8")
    body = skill.split("---\n", 2)[2].lstrip()
    rules, catalog = body.split("## Prompt da usare nell’agente\n", 1)
    topics = {}
    for block in re.split(r"\n(?=### )", catalog.strip()):
        heading, prompt = block.split("\n", 1)
        topics[heading.split()[1]] = prompt.strip()
    if not args or args in (["-h"], ["--help"]):
        print(HELP)
    elif args == ["--version"]:
        print(version("abliterate"))
    elif args == ["skill"]:
        sys.stdout.write(skill)
    elif args == ["prompt"]:
        print("Scegli un prompt: abliterate prompt TEMA")
        print("\n".join(line[4:] for line in catalog.splitlines() if line.startswith("### ")))
    elif (len(args) == 2 and args[0] == "prompt" and args[1] in topics
          or args == ["review"] or len(args) == 3 and args[:2] == ["review", "--since"]
          and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", args[2])):
        topic = args[1] if args[0] == "prompt" else "review"
        parts = ["Istruzioni per l’agente · Abliterate", rules.strip(), topics[topic].strip()]
        if len(args) == 3:
            parts.append("Base Git richiesta: " + args[2])
        print("\n\n".join(parts))
    else:
        print(HELP, file=sys.stderr)
        return 2
    return 0
