"""Page count of a compiled PDF against the venue limit (dimension document.page-limit;
reference.inside-page-limit says whether references count).

CLI: ``academia-write page-budget [main.pdf] [--project DIR] [--json]``.
Exit codes: 0 within the limit (or no limit set), 1 over the limit, 2 usage error.
"""

from __future__ import annotations

import contextlib
import json
import re
import sys
import zlib
from datetime import UTC, datetime
from pathlib import Path

from academia.knowledge.resolve import defaults_note, dim, find_project, resolve

CHECKS = ["page-limit"]
_PAGE = re.compile(rb"/Type\s*/Page(?![s\w])")


def count_pages(buf: bytes) -> int:
    """Count page objects in a PDF, including compressed object streams."""
    n = len(_PAGE.findall(buf))
    pos = 0
    rx = re.compile(rb"stream\r?\n")
    while True:
        m = rx.search(buf, pos)
        if not m:
            break
        start = m.end()
        end = buf.find(b"endstream", start)
        if end < 0:
            break
        with contextlib.suppress(zlib.error):  # not a Flate stream
            n += len(_PAGE.findall(zlib.decompressobj().decompress(buf[start:end])))
        pos = end
    return n


def pages_from_log(log: str) -> int | None:
    """Pages from a LaTeX log ("Output written on main.pdf (6 pages"), else None."""
    m = re.search(r"Output written on .*?\((\d+) pages?", log, re.DOTALL)
    return int(m.group(1)) if m else None


def run(args) -> int:
    """``academia-write page-budget``."""
    root = Path(args.project).resolve() if args.project else find_project()
    pdf = Path(args.pdf).resolve() if args.pdf else (root or Path(".")).resolve() / "main.pdf"
    if not pdf.exists():
        print(f"page-budget: {pdf} not found; compile first", file=sys.stderr)
        return 2
    cfg = resolve(root)
    if cfg.errors:
        for e in cfg.errors:
            print(f"jurisdiction: {e}", file=sys.stderr)
        return 2
    used: set[str] = set()
    limit = dim(cfg, "document.page-limit", used)
    refs_inside = dim(cfg, "reference.inside-page-limit", used)
    pages = count_pages(pdf.read_bytes())
    log = pdf.with_suffix(".log")
    if not pages and log.exists():
        pages = pages_from_log(log.read_text(encoding="latin-1")) or 0
    over = limit != "none" and pages > int(limit)
    pdf_time = (
        datetime.fromtimestamp(round(pdf.stat().st_mtime_ns / 1e6) / 1000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    res = {
        "pdf": str(pdf),
        "pdfTime": pdf_time,
        "pages": pages,
        "limit": limit,
        "referencesInside": refs_inside,
        "over": over,
        "defaults": sorted(used),
    }
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        refs = (
            f", references {'inside' if refs_inside == 'yes' else 'outside'} the limit"
            if limit != "none"
            else ""
        )
        print(f"{pdf}: {pages} pages (PDF time {pdf_time}); limit {limit}{refs}")
        if used:
            print(defaults_note(used))
        if over:
            print(
                f"[error document.page-limit] {pages - int(limit)} page(s) over the limit: offer a compensating cut"
            )
        if refs_inside == "no" and limit != "none":
            print("note: references are outside the limit; the count above includes them")
    return 1 if over else 0
