"""Table checks from the effective configuration: abbreviated names (table vocabulary), slash-joined
quantities, units in value cells, unit bracket style (dimension table.unit-brackets). A cell starting with
a number is a value cell; any other non-empty cell is a name cell (tables may hold several name-value pairs
per row).

CLI: ``academia-write lint-table [files] [--project DIR] [--json]``. Exit codes: 0 no hits, 1 hits, 2 usage or
jurisdiction error.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from academia.documents.tex import default_tex_files, table_rows, words
from academia.knowledge.resolve import (
    Config,
    compile_term,
    defaults_note,
    dim,
    find_project,
    resolve,
)

CHECKS = ["table-abbreviation", "table-slash", "table-unit"]
A = re.ASCII


def lint_tables(src: str, file: str, cfg: Config, used: set[str] | None = None) -> list[dict]:
    """Hits for one file's source against a resolved configuration."""
    used = set() if used is None else used
    hits: list[dict] = []

    def add(line: int, rule: str, message: str, text: str) -> None:
        hits.append(
            {
                "file": file,
                "line": line,
                "rule": rule,
                "severity": "error",
                "message": message,
                "text": text,
            }
        )

    abbrev = [
        {**v, "re": compile_term(v["term"])} for v in cfg.vocabulary if v["content"] == "table"
    ]
    unit_alt = "|".join(
        sorted((re.escape(u["latex"]) for u in cfg.data["units"]), key=len, reverse=True)
    )
    slash_units = [u["latex"] for u in cfg.data["units"] if "/" in u["unit"]]
    brackets = dim(cfg, "table.unit-brackets", used)
    wrong = re.compile(rf"\(({unit_alt})\)" if brackets == "brackets" else rf"\[({unit_alt})\]", A)
    value_unit = re.compile(rf"^[-+]?\d[\d.,]*\s*(\\,|~|\s)?\s*({unit_alt})\s*$", A)
    slash_re = re.compile("|".join(re.escape(u) for u in dict.fromkeys(slash_units)) or "$^")

    def is_value(c: str) -> bool:
        return re.match(r"^[-+]?\d", c, A) is not None

    for row in table_rows(src):
        line, cells = row["line"], row["cells"]
        for name in (c for c in cells if c and not is_value(c)):
            name_text = words(name)
            for v in abbrev:
                m = v["re"].search(name_text)
                if m:
                    add(
                        line,
                        "table.full-names",
                        f'"{m.group(0)}" -> {v["replace"]} (name in full)',
                        name,
                    )
            if wrong.search(name):
                add(
                    line,
                    "table.unit",
                    f'"{name}": units in {brackets} brackets (table.unit-brackets = {brackets})',
                    name,
                )
        for c in cells:
            bare = slash_re.sub(" ", c)
            if re.search(r"\s/\s|[A-Za-z0-9]/[A-Za-z]", bare):
                add(
                    line,
                    "table.one-quantity-per-cell",
                    f'"{c}": one quantity per cell, no slash',
                    c,
                )
        for c in (c for c in cells if is_value(c)):
            if value_unit.search(c.strip()):
                add(
                    line,
                    "table.unit",
                    f'"{c}": unit belongs after the name in {brackets} brackets; the value cell holds a bare number',
                    c,
                )
    return hits


def run(args) -> int:
    """``academia-write lint-table``."""
    root = Path(args.project).resolve() if args.project else find_project()
    cfg = resolve(root)
    if cfg.errors:
        for e in cfg.errors:
            print(f"jurisdiction: {e}", file=sys.stderr)
        return 2
    files = [Path(f) for f in args.files] or default_tex_files(root or Path("."))
    used: set[str] = set()
    hits = [h for f in files for h in lint_tables(f.read_text(encoding="utf-8"), f.name, cfg, used)]
    if args.json:
        print(json.dumps({"defaults": sorted(used), "hits": hits}, indent=2, ensure_ascii=False))
    else:
        if used:
            print(defaults_note(used))
        for h in hits:
            print(f"{h['file']}:{h['line']}  [{h['severity']} {h['rule']}] {h['message']}")
        print(f"{len(hits)} table hits")
    return 1 if hits else 0
