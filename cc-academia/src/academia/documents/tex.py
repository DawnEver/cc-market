"""LaTeX source to prose units for the checkers: sentences (with section and line), captions, table rows,
and lines outside maths/code. No style knowledge lives here; checkers get their data from resolve."""

from __future__ import annotations

import re
from pathlib import Path

A = re.ASCII
SKIP_ENV = re.compile(
    r"\\(begin|end)\{(figure\*?|table\*?|tikzpicture|equation\*?|align\*?|gather\*?|multline\*?|tabular\*?|verbatim|lstlisting|minted|comment|thebibliography)\}",
    A,
)
NO_TEXT_ENV = re.compile(
    r"\\(begin|end)\{(equation|align|gather|multline|eqnarray|displaymath|math|verbatim|lstlisting|minted|comment|thebibliography|quote|quotation|tikzpicture)\*?\}",
    A,
)
# Commands whose arguments are all code: keys, labels, paths, colour names, options.
CODE_ALL = re.compile(
    r"\\(cite\w*|ref|eqref|autoref|[cC]ref|pageref|label|begin|end|includegraphics|input|include|usepackage|RequirePackage|documentclass|definecolor|colorlet|bibliography|bibliographystyle|bibitem|url|hypersetup|tikzset|pgfplotsset|setlength|newcommand|renewcommand|providecommand|usetikzlibrary|newenvironment|pagestyle|thispagestyle|vspace|hspace)\*?(\s*\[[^\]]*\]|\s*\{[^{}]*\})*",
    A,
)
CODE_FIRST = re.compile(
    r"\\(color|textcolor|colorbox|fcolorbox|pagecolor|href)\s*(\[[^\]]*\])?\s*\{[^{}]*\}", A
)
REFS = re.compile(r"\\(cite\w*|ref|eqref|autoref|[cC]ref|pageref)\{[^}]*\}", A)
_LINES = re.compile(r"\r?\n")


def strip_comment(line: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", line, count=1)


def math_words(m: str) -> str:
    """Words of an inline maths fragment: "$\\alpha\\beta$" -> "alpha beta", "$xy$" -> "xy"."""
    s = re.sub(r"^\$+|\$+$", "", m)
    s = re.sub(r"\\([a-zA-Z]+)", r" \1 ", s)
    s = re.sub(r"[{}^_\\]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def prose_only(line: str) -> str:
    """A line reduced to the words a spelling check may see: maths, quotations and code removed."""
    s = re.sub(r"\$\$?[^$]*\$\$?|\\\(.*?\\\)|\\\[.*?\\\]", " ", line)
    s = re.sub(r"``.*?''|\\enquote\{[^}]*\}", " ", s)
    s = CODE_ALL.sub(" ", s)
    s = CODE_FIRST.sub(" ", s)
    s = re.sub(r"\[[^\]]*\]", " ", s)
    s = re.sub(r"[\w./-]+\s*=\s*[\w!./-]+", " ", s, flags=A)
    s = re.sub(r"\\[a-zA-Z@]+\*?", " ", s)
    return re.sub(r"\w*_\w*", " ", s, flags=A)


def words(s: str) -> str:
    """Readable text of a LaTeX fragment: refs/cites -> X, maths -> its words, commands dropped."""
    s = REFS.sub("X", s)
    s = re.sub(r"\\label\{[^}]*\}", " ", s)
    s = re.sub(r"\$[^$]*\$", lambda m: math_words(m.group(0)), s)
    s = re.sub(r"\\[,;: ]", " ", s)
    s = re.sub(r"\\([a-zA-Z]+)\*?", " ", s)
    s = re.sub(r"[{}~]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(s: str) -> str:
    """Grammar view: refs/cites -> X, inline maths -> M, commands dropped."""
    s = REFS.sub("X", s)
    s = re.sub(r"\\label\{[^}]*\}", " ", s)
    s = re.sub(r"\$[^$]*\$", "M", s)
    s = re.sub(r"\\[,;: ]", " ", s)
    s = re.sub(r"\\[a-zA-Z]+\*?(\{[^}]*\})?", " ", s)
    s = re.sub(r"[{}~]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


_SPLIT = re.compile("(?<=[.!?])\\s+(?=[A-Z\\\\\u0001])")
_SECTION = re.compile(r"^\\section\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}")
_BREAK = re.compile(
    r"^\\(sub)*section|^\\label|^\\noindent\\textbf|^\\(begin|end)\{abstract\}|^\\vspace"
)


def sentences(src: str) -> list[dict]:
    """Sentences of the running prose: [{line, raw, text, plain, section}]; ``text`` is the words view
    (vocabulary), ``plain`` the token view (grammar); floats, TikZ and display maths are skipped.
    ``section`` is the current \\section title, or "Abstract" after an abstract heading."""
    out: list[dict] = []
    buf: list[tuple[int, str]] = []
    state = {"depth": 0, "section": ""}

    def flush() -> None:
        if not buf:
            return
        joined, starts, maths = "", [], []
        for line, s in buf:
            starts.append((len(joined), line))

            def protect(m: re.Match) -> str:
                maths.append(m.group(0))
                return f"\u0001{len(maths) - 1}\u0002"

            joined += re.sub(r"\$[^$]*\$", protect, s) + " "

        def line_at(off: int) -> int:
            ln = starts[0][1]
            for o, start_line in starts:
                if o <= off:
                    ln = start_line
            return ln

        pieces, last = [], 0
        for m in _SPLIT.finditer(joined):
            pieces.append((last, joined[last : m.start()]))
            last = m.end()
        pieces.append((last, joined[last:]))
        for off, piece in pieces:
            lead = len(piece) - len(piece.lstrip())
            raw = re.sub("\u0001(\\d+)\u0002", lambda g: maths[int(g.group(1))], piece.strip())
            if not raw:
                continue
            out.append(
                {
                    "line": line_at(off + lead),
                    "raw": raw,
                    "text": words(raw),
                    "plain": tokens(raw),
                    "section": state["section"],
                }
            )
        buf.clear()

    for i, raw_line in enumerate(_LINES.split(src)):
        s = strip_comment(raw_line).strip()
        m = SKIP_ENV.search(s)
        if m and m.group(1) == "begin":
            flush()
            state["depth"] += 1
        if state["depth"]:
            if m and m.group(1) == "end":
                state["depth"] -= 1
            continue
        sec = _SECTION.match(s)
        if sec:
            state["section"] = sec.group(1).strip()
        if re.search(r"\\textbf\{Abstract\}|\\begin\{abstract\}", s):
            state["section"] = "Abstract"
        if not s or _BREAK.search(s):
            flush()
            continue
        buf.append((i + 1, s))
    flush()
    return out


def braced(src: str, i: int) -> tuple[str, int]:
    """Balanced-brace argument starting at src[i] == '{'; returns (content, end index)."""
    d, j = 0, i
    while j < len(src):
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            d += 1
        elif c == "}":
            d -= 1
            if d == 0:
                return src[i + 1 : j], j
        j += 1
    return src[i + 1 :], len(src)


def _clean(src: str) -> str:
    return "\n".join(strip_comment(line) for line in _LINES.split(src))


def captions(src: str) -> list[dict]:
    """Captions: [{line, raw, text, plain, section}] from \\caption[...]{...} (comments removed)."""
    clean = _clean(src)
    out = []
    for m in re.finditer(r"\\caption\*?\s*(\[[^\]]*\])?\s*\{", clean):
        body, _ = braced(clean, m.end() - 1)
        raw = re.sub(r"\s+", " ", body).strip()
        out.append(
            {
                "line": clean[: m.start()].count("\n") + 1,
                "raw": raw,
                "text": words(raw),
                "plain": tokens(raw),
                "section": "caption",
            }
        )
    return out


def text_lines(src: str) -> list[dict]:
    """Lines that may carry prose (outside maths, code and bibliography environments): [{line, s}]."""
    out, depth = [], 0
    for i, raw in enumerate(_LINES.split(src)):
        s = strip_comment(raw)
        envs = list(NO_TEXT_ENV.finditer(s))
        for e in envs:
            depth = max(0, depth + (1 if e.group(1) == "begin" else -1))
        if depth or envs:
            continue
        out.append({"line": i + 1, "s": s})
    return out


_RULE_CMDS = re.compile(
    r"\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\}|cmidrule(\([^)]*\))?\{[^}]*\})"
)


def table_rows(src: str) -> list[dict]:
    """Rows of tabular environments: [{line, cells}]; rules (\\hline, \\toprule ...) skipped."""
    out = []
    clean = _clean(src)
    for m in re.finditer(r"\\begin\{tabular\*?\}(\{[^}]*\}|\[[^\]]*\])*", clean):
        end = clean.find("\\end{tabular", m.start())
        body = clean[m.end() : end if end >= 0 else None]
        offset = m.end()
        for row in body.split("\\\\"):
            first = re.search(r"\S|$", row).start()
            line = clean[: offset + first].count("\n") + 1
            offset += len(row) + 2
            t = _RULE_CMDS.sub("", row).strip()
            if not t:
                continue
            out.append({"line": line, "cells": [c.strip() for c in re.split(r"(?<!\\)&", t)]})
    return out


def default_tex_files(d: Path | str) -> list[Path]:
    """Default .tex files of a project: Sections/*.tex under dir, else *.tex in dir."""
    d = Path(d)
    base = d / "Sections" if (d / "Sections").exists() else d
    return sorted((p for p in base.iterdir() if p.name.endswith(".tex")), key=lambda p: p.name)


def strip_code(line: str) -> str:
    """A line with code removed (command options, keys, labels, paths) but maths and text kept."""
    return re.sub(r"\[[^\]]*\]", " ", CODE_FIRST.sub(" ", CODE_ALL.sub(" ", line)))
