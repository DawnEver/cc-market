"""``academia-write`` — the deterministic half of manuscript writing.

Resolve the knowledge sources a LaTeX project names, lint its prose and tables, check its result numbers,
page budget and word count, and check figures. Judgement (argument, moves, claim strength) is the
reviewer agent's job and has no command. Every check reads ``knowledge/`` through ``resolve``.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import sys
from pathlib import Path


def _number(raw: str) -> float | int:
    v = float(raw)
    return int(v) if v.is_integer() else v


def _project(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--project",
        help="LaTeX project root (default: nearest dir with .academia/profile.tsv).",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="academia-write", description="Manuscript writing checks over the knowledge base."
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser(
        "resolve", help="Merged knowledge configuration with provenance and jurisdiction errors."
    )
    _project(p)
    for kind in ("venue", "field", "preset"):
        p.add_argument(
            f"--{kind}",
            action="append",
            help=f"Add a {kind} source (repeatable); for manuscripts without a profile.",
        )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--json", action="store_true", help="Effective configuration as JSON.")
    mode.add_argument(
        "--md", action="store_true", help="Rules, dimensions, criteria and templates as Markdown."
    )
    mode.add_argument("--criteria", action="store_true", help="Review criteria only, as Markdown.")
    mode.add_argument(
        "--task",
        choices=["write", "review"],
        help="Context index for an agent: one line per item to judge on --scope (write: rules "
        "not checked by lint; review: criteria of --angle), then the dimension values. "
        "Details: academia-write explain <id>.",
    )
    p.add_argument(
        "--scope",
        help="Manuscript part: with --task required (title, abstract, keywords, introduction, "
        "body, conclusion, caption, table, data-plot, schematic, multi-panel, review-comment); "
        "with --md keeps the rules applying to it.",
    )
    p.add_argument(
        "--applies",
        choices=["self", "peer"],
        help="With --criteria or --task review: who applies them.",
    )
    p.add_argument(
        "--angle",
        action="append",
        help="With --criteria or --task review: keep these angles (repeatable).",
    )

    p = sub.add_parser(
        "explain", help="Every field of one rule, criterion or dimension, with its effective value."
    )
    p.add_argument("id")
    _project(p)

    p = sub.add_parser("lint-prose", help="Data-driven prose checks; hits name their rule.")
    p.add_argument("files", nargs="*")
    _project(p)
    p.add_argument("--json", action="store_true")
    p.add_argument(
        "--min", default="warn", help="Lowest severity shown: error, warn or info (default warn)."
    )

    p = sub.add_parser(
        "lint-table", help="Table checks: full names, one quantity per cell, unit placement."
    )
    p.add_argument("files", nargs="*")
    _project(p)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser(
        "check-data", help="Number registry: recompute numbers.tsv, find hand-typed numbers."
    )
    p.add_argument("files", nargs="*")
    _project(p)
    p.add_argument("--write", action="store_true", help="Write numbers.tex defining \\val{id}.")
    p.add_argument("--out", help="Target of --write (default <project>/numbers.tex).")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("page-budget", help="PDF page count against the venue page limit.")
    p.add_argument("pdf", nargs="?")
    _project(p)
    p.add_argument("--json", action="store_true")

    p = sub.add_parser(
        "word-count", help="texcount per section and grand total, references excluded."
    )
    p.add_argument("root", nargs="?", default=".")
    p.add_argument("--target", type=_number, help="Word-count target for the progress line.")
    p.add_argument("--json", action="store_true")
    p.add_argument("--texcount", help='texcount command (default: $TEXCOUNT or "texcount").')

    p = sub.add_parser(
        "check-figure", help="Numeric figure checks on a figure built by a script function."
    )
    p.add_argument("script", help="Python file defining the figure function.")
    p.add_argument(
        "function", help="Function returning a matplotlib Figure (or drawing the current one)."
    )
    _project(p)
    p.add_argument("--baseline", help="Saved layout JSON (figure.save_baseline) to diff against.")
    p.add_argument(
        "--arg",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Keyword argument for the figure function (repeatable; values are strings).",
    )
    p.add_argument("--json", action="store_true")
    return parser


def run_check_figure(args: argparse.Namespace) -> int:
    """``academia-write check-figure``: build the figure, run figure.check_figure; exit 1 on any issue."""
    import json

    try:
        import matplotlib
    except ImportError:
        print(
            "check-figure: needs matplotlib; install the extra: uv sync --extra plot",
            file=sys.stderr,
        )
        return 2
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from academia import figure
    from academia.knowledge.resolve import find_project

    script = Path(args.script).resolve()
    if not script.exists():
        print(f"check-figure: {script} not found", file=sys.stderr)
        return 2
    spec = importlib.util.spec_from_file_location(script.stem, script)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(script.parent))
    spec.loader.exec_module(module)
    fn = getattr(module, args.function, None)
    if fn is None:
        print(f"check-figure: {script.name} defines no function {args.function}", file=sys.stderr)
        return 2
    kwargs = {}
    for a in args.arg:
        name, sep, value = a.partition("=")
        if not sep or not name:
            print(f'check-figure: --arg "{a}" must be name=value', file=sys.stderr)
            return 2
        kwargs[name] = value
    missing = [
        n
        for n, prm in inspect.signature(fn).parameters.items()
        if prm.default is prm.empty
        and prm.kind in (prm.POSITIONAL_OR_KEYWORD, prm.KEYWORD_ONLY)
        and n not in kwargs
    ]
    if missing:
        doors = " ".join(f"--arg {n}=<value>" for n in missing)
        print(
            f"check-figure: {args.function} needs argument {', '.join(missing)}; pass {doors}"
            " (the project's .academia/figures.tsv data column names the usual value)",
            file=sys.stderr,
        )
        return 2
    fig = fn(**kwargs) or plt.gcf()
    root = Path(args.project).resolve() if args.project else find_project(script.parent)
    font = figure.load_dimensions(root)["figure.font-size-pt"]
    issues = figure.check_figure(fig, font_size=font, baseline=args.baseline)
    if args.json:
        print(json.dumps({"figure": f"{script.name}:{args.function}", "issues": issues}, indent=2))
    else:
        for i in issues:
            print(f"[{i['check']} {i['rule']}] {i['message']}")
        print(f"{len(issues)} figure issues ({script.name}:{args.function}, {font} pt)")
    return 1 if issues else 0


def handlers() -> dict:
    from academia.check import numbers, pages, prose, table, words
    from academia.knowledge import resolve

    return {
        "resolve": resolve.run,
        "explain": resolve.run_explain,
        "lint-prose": prose.run,
        "lint-table": table.run,
        "check-data": numbers.run,
        "page-budget": pages.run,
        "word-count": words.run,
        "check-figure": run_check_figure,
    }
