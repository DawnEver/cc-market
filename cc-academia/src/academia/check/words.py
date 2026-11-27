"""Count words in a LaTeX project with texcount.

Finds main.tex (project root, the single ``*/main.tex`` beneath it, or an explicit path argument), runs
``texcount -inc -sum -sub=section``, and prints a breakdown (per section for article-style documents, per
file for chapter-style documents) plus the grand total. The bibliography is never counted: references live
in .bib files, outside the \\input chain. Sums follow texcount's "Sum count": text + headers + captions +
math (inline and displayed).

CLI: ``academia-write word-count [root] [--target N] [--json] [--texcount "cmd"]``
(texcount command default: $TEXCOUNT or "texcount").
Exit codes: 0 ok, 1 texcount missing or failed, 2 usage or discovery error.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# texcount 3.x subcount line: "  7+1+0 (1/0/0/0) Section: Abstract", and the trailing per-file summary
# (chapter-style documents): "  197+1+0 (1/0/0/0) Included file: ./Sections/1-abstract.tex".
UNIT_RE = re.compile(
    r"^\s*(\d+)\+(\d+)\+(\d+)\s+\((\d+)/(\d+)/(\d+)/(\d+)\)\s+(?:Section|Included file|File):\s+(.+)$"
)
# -sum summary line; the LAST one in the output is the grand total (Sum of files block).
SUM_RE = re.compile(r"^Sum count:\s*(\d+)$")


def _unit(m: re.Match) -> dict:
    text, headers, captions = int(m.group(1)), int(m.group(2)), int(m.group(3))
    # The parenthesised tuple is (#headers/#floats/#inlines/#displayed); only the maths counts belong in the sum.
    inlines, displayed = int(m.group(6)), int(m.group(7))
    return {
        "name": m.group(8),
        "text": text,
        "headers": headers,
        "captions": captions,
        "sum": text + headers + captions + inlines + displayed,
    }


def find_main_tex(root: Path | str) -> dict:
    """Locate main.tex: an explicit file argument, the root itself, or a single depth-1 subdirectory."""
    d = Path(root).resolve()
    if d.is_file():
        return {"dir": str(d.parent), "main": d.name}
    if (d / "main.tex").exists():
        return {"dir": str(d), "main": "main.tex"}
    candidates = [str(c) for c in sorted(d.iterdir()) if c.is_dir() and (c / "main.tex").exists()]
    if not candidates:
        raise ValueError(f"no main.tex found under {d} (searched the root and its subdirectories)")
    if len(candidates) > 1:
        raise ValueError(
            "multiple main.tex found; pick one explicitly:\n  " + "\n  ".join(candidates)
        )
    return {"dir": candidates[0], "main": "main.tex"}


def tokenize(cmdline: str) -> list[str]:
    """Split a command line into tokens, honouring double quotes (for paths with spaces)."""
    return [
        m.group(1) if m.group(1) is not None else m.group(2)
        for m in re.finditer(r'"([^"]*)"|(\S+)', cmdline)
    ]


def run_texcount(cwd: str, main: str, command: str) -> subprocess.CompletedProcess:
    """Run texcount from the project dir; raises FileNotFoundError when the binary is missing."""
    cmd = tokenize(command)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    return subprocess.run(
        [*cmd, "-inc", "-sum", "-sub=section", main],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
        check=False,
    )


def parse_texcount(output: str) -> dict:
    """texcount output -> {sections, total}. "Section:" subcounts when texcount emits them (article-style);
    otherwise the trailing per-file summary, labelled by file path. Handles LF and CRLF."""
    sections, files, total = [], [], None
    for line in re.split(r"\r?\n", output):
        m = UNIT_RE.match(line)
        if m:
            u = _unit(m)
            if "Section:" in line:
                sections.append(u)
            else:
                files.append({**u, "name": re.sub(r"^\./", "", u["name"])})
            continue
        t = SUM_RE.match(line)
        if t:
            total = int(t.group(1))
    if total is None:
        raise ValueError('could not parse texcount output: no "Sum count" line found')
    return {"sections": sections or files, "total": total}


def fmt(n: int) -> str:
    return f"{n:,}"


def format_table(sections: list[dict], total: int) -> str:
    """Aligned per-section table plus the grand total."""
    width = max([len(s["name"]) for s in sections] + [len("Section")])
    rows = [f"{s['name'].ljust(width)}  {str(s['sum']).rjust(5)}" for s in sections]
    return "\n".join(
        [
            f"{'Section'.ljust(width)}  Words",
            f"{'-' * width}  -----",
            *rows,
            f"{'Total (excl. references)'.ljust(width)}  {str(total).rjust(5)}",
        ]
    )


def target_line(total: int, target: float) -> str:
    pct = int((total / target) * 100 + 0.5)
    return f"Target: {fmt(total)} / {fmt(int(target))} ({pct}%)"


def run(args) -> int:
    """``academia-write word-count``."""
    command = args.texcount or os.environ.get("TEXCOUNT") or "texcount"
    try:
        found = find_main_tex(args.root)
    except (ValueError, OSError) as e:
        print(e, file=sys.stderr)
        return 2
    try:
        r = run_texcount(found["dir"], found["main"], command)
    except OSError:
        print(
            f"texcount not found: {command} — install it (tlmgr install texcount)", file=sys.stderr
        )
        return 1
    if r.returncode != 0:
        print(
            f"texcount failed (exit {r.returncode}):\n{(r.stderr or r.stdout).strip()}",
            file=sys.stderr,
        )
        return 1
    try:
        parsed = parse_texcount(r.stdout)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    if args.json:
        print(
            json.dumps(
                {
                    "root": found["dir"],
                    "main": found["main"],
                    "total": parsed["total"],
                    "target": args.target,
                    "sections": parsed["sections"],
                },
                indent=2,
            )
        )
    else:
        print(f"Counting {found['main']} in {found['dir']}")
        print(format_table(parsed["sections"], parsed["total"]))
        if args.target is not None:
            print(target_line(parsed["total"], args.target))
    return 0
