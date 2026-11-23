"""Number registry. Reads ``<project>/.academia/numbers.tsv`` (id value unit expr source round), evaluates
each expression over its CSV source (path relative to the project root; a name ``run.column`` reads the row
whose first column is ``run``), compares the rounded result with the registered value, and with --write
emits numbers.tex defining ``\\val{id}``. It also reports numbers typed by hand in the prose that equal a
registry value (data.registry).

CLI: ``academia-write check-data [files] [--project DIR] [--write] [--out FILE] [--json]``.
Exit codes: 0 registry consistent, 1 mismatch or hand-typed numbers, 2 usage error.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Callable
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from academia.documents.tex import default_tex_files, strip_code, text_lines
from academia.knowledge.resolve import PROJECT_DIR, find_project, read_tsv

CHECKS = ["number-registry"]


def _split_csv(line: str) -> list[str]:
    out, cur, q, i = [], "", False, 0
    while i < len(line):
        c = line[i]
        if q:
            if c == '"' and i + 1 < len(line) and line[i + 1] == '"':
                cur += '"'
                i += 1
            elif c == '"':
                q = False
            else:
                cur += c
        elif c == '"':
            q = True
        elif c == ",":
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out


def read_csv(file: Path | str) -> dict:
    """Minimal CSV reader (quoted fields supported): {header, rows: {key: {col: value}}}."""
    lines = [ln for ln in re.split(r"\r?\n", Path(file).read_text(encoding="utf-8")) if ln]
    header = [h.strip() for h in _split_csv(lines[0])]
    rows = {}
    for line in lines[1:]:
        c = _split_csv(line)
        rows[c[0].strip()] = {h: (c[i] if i < len(c) else "").strip() for i, h in enumerate(header)}
    return {"header": header, "rows": rows}


_TOKEN = re.compile(
    r"\d+(?:\.\d+)?(?:e[-+]?\d+)?|[A-Za-z_][\w-]*\.[A-Za-z_]\w*|[-+*/()]|\S", re.ASCII
)


def evaluate(expr: str, lookup: Callable[[str], float]) -> float:
    """Arithmetic over ``lookup(name)``: numbers, run.column names, + - * / and parentheses."""
    toks = _TOKEN.findall(expr)
    pos = [0]

    def peek() -> str | None:
        return toks[pos[0]] if pos[0] < len(toks) else None

    def take(t: str) -> None:
        if peek() != t:
            raise ValueError(f'expected "{t}" at token {pos[0] + 1} of "{expr}"')
        pos[0] += 1

    def atom() -> float:
        t = peek()
        pos[0] += 1
        if t is None:
            raise ValueError(f'unexpected end of "{expr}"')
        if t == "(":
            v = total()
            take(")")
            return v
        if t == "-":
            return -atom()
        if t == "+":
            return atom()
        if t[0].isdigit():
            return float(t)
        if re.match(r"[A-Za-z_]", t):
            return lookup(t)
        raise ValueError(f'unexpected "{t}" in "{expr}"')

    def product() -> float:
        v = atom()
        while peek() in ("*", "/"):
            op = toks[pos[0]]
            pos[0] += 1
            r = atom()
            v = v * r if op == "*" else v / r
        return v

    def total() -> float:
        v = product()
        while peek() in ("+", "-"):
            op = toks[pos[0]]
            pos[0] += 1
            r = product()
            v = v + r if op == "+" else v - r
        return v

    v = total()
    if pos[0] != len(toks):
        raise ValueError(f'trailing "{" ".join(toks[pos[0] :])}" in "{expr}"')
    return v


def to_fixed(x: float, digits: int) -> str:
    """JavaScript ``Number.prototype.toFixed``: round half away from zero on the binary value."""
    q = Decimal(1).scaleb(-digits)
    d = Decimal(x).quantize(q, rounding=ROUND_HALF_UP)
    return f"{d:.{digits}f}"


def to_precision(x: float, digits: int = 6) -> str:
    """JavaScript ``Number.prototype.toPrecision`` (fixed notation for exponents -6..digits-1)."""
    if x == 0:
        return f"{0:.{digits - 1}f}"
    e = int(f"{x:.{digits - 1}e}".split("e")[1])
    if -6 <= e < digits:
        return f"{x:.{max(digits - 1 - e, 0)}f}"
    mant, exp = f"{x:.{digits - 1}e}".split("e")
    return f"{mant}e{'+' if int(exp) >= 0 else '-'}{abs(int(exp))}"


UNIT_TEX = {"%": "\\%", "deg": "$^\\circ$"}


def tex_value(value: str, unit: str) -> str:
    """LaTeX text of a value with its unit: thin space except for degrees."""
    if not unit:
        return value
    if unit == "deg":
        return f"{value}{UNIT_TEX['deg']}"
    return f"{value}\\,{UNIT_TEX.get(unit, unit)}"


def check_registry(root: Path | str) -> list[dict]:
    """Check a project's registry: [{id, value, computed, rounded, ok, error}]."""
    root = Path(root)
    rows, errors = read_tsv(root.joinpath(*PROJECT_DIR, "numbers.tsv"), None, root)
    if errors:
        raise ValueError("; ".join(errors))
    cache: dict[Path, dict] = {}
    out = []
    for r in rows:
        try:
            src = (root / r["source"]).resolve()
            if src not in cache:
                cache[src] = read_csv(src)
            csv = cache[src]

            def lookup(name: str, csv: dict = csv, r: dict = r) -> float:
                run, col = name.split(".", 1)
                row = csv["rows"].get(run)
                if row is None:
                    raise ValueError(f'no row "{run}" in {r["source"]}')
                if col not in row:
                    raise ValueError(f'no column "{col}" in {r["source"]}')
                try:
                    return float(row[col])
                except ValueError:
                    raise ValueError(f'{name} = "{row[col]}" is not a number') from None

            computed = evaluate(r["expr"], lookup)
            rounded = to_fixed(computed, int(r.get("round") or 0))
            out.append({**r, "computed": computed, "rounded": rounded, "ok": rounded == r["value"]})
        except (OSError, ValueError, ZeroDivisionError) as e:
            out.append({**r, "ok": False, "error": str(e)})
    return out


def numbers_tex(results: list[dict]) -> str:
    """numbers.tex content defining ``\\val{id}``."""
    lines = [
        "% Generated by cc-academia `academia-write check-data --write` from .academia/numbers.tsv; do not edit.",
        "% Use \\val{id} in the text.",
        "\\makeatletter",
        "\\newcommand{\\val}[1]{\\@ifundefined{ccval@#1}{\\textbf{??#1??}\\PackageWarning{numbers}{unknown number id #1}}{\\@nameuse{ccval@#1}}}",
    ]
    lines += [
        f"\\@namedef{{ccval@{r['id']}}}{{{tex_value(r['value'], r['unit'])}}}" for r in results
    ]
    lines.append("\\makeatother")
    return "\n".join(lines) + "\n"


def hand_typed(src: str, results: list[dict]) -> list[dict]:
    """Hand-typed numbers in prose equal to a registry value: [{line, id, text}]."""
    out = []
    for tl in text_lines(src):
        t = strip_code(tl["s"])
        for r in results:
            unit = (
                "\\\\%"
                if r["unit"] == "%"
                else "\\$\\^\\\\circ\\$"
                if r["unit"] == "deg"
                else re.escape(r["unit"])
            )
            m = re.search(
                rf"(?<![\d.]){r['value'].replace('.', chr(92) + '.', 1)}\s*(\\,|~|\s)?\s*{unit}(?![A-Za-z])",
                t,
                re.ASCII,
            )
            if m:
                out.append({"line": tl["line"], "id": r["id"], "text": m.group(0)})
    return out


def run(args) -> int:
    """``academia-write check-data``."""
    root = Path(args.project).resolve() if args.project else find_project()
    if not root or not root.joinpath(*PROJECT_DIR, "numbers.tsv").exists():
        print(
            "check-data: no .academia/numbers.tsv; create it with columns id value unit expr source round (workflow data)",
            file=sys.stderr,
        )
        return 2
    results = check_registry(root)
    files = [Path(f) for f in args.files] or default_tex_files(root)
    typed = [
        {"file": f.name, **h}
        for f in files
        for h in hand_typed(f.read_text(encoding="utf-8"), results)
    ]
    if args.json:
        print(json.dumps({"results": results, "handTyped": typed}, indent=2, ensure_ascii=False))
    else:
        for r in results:
            head = f"{'ok   ' if r['ok'] else '[error data.registry]'} {r['id']} = {r['value']} {r['unit']}"
            print(
                head
                + (
                    f": {r['error']}"
                    if r.get("error")
                    else f"  (computed {to_precision(r['computed'])} -> {r['rounded']})"
                )
            )
        for h in typed:
            print(
                f'{h["file"]}:{h["line"]}  [error data.registry] "{h["text"]}" -> \\val{{{h["id"]}}}'
            )
    bad = [r for r in results if not r["ok"]]
    if args.write:
        if bad:
            print("check-data: registry has errors; numbers.tex not written", file=sys.stderr)
            return 1
        target = Path(args.out).resolve() if args.out else root / "numbers.tex"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(numbers_tex(results), encoding="utf-8")
        print(f"wrote {target}")
    return 1 if bad or typed else 0
