"""Artifact verification — the single definition of "is this a usable PDF".

These three helpers previously existed twice, in `acquire/download.py` and
`pipeline/acquire.py`, with *different* acceptance rules: the download side
checked only the magic bytes, the manifest side also required a minimum size.
A truncated stub therefore passed download and failed later at manifest time,
after the queue had already recorded it as a success. One definition, used by
both, is the only way that stays fixed.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

MIN_PDF_BYTES = 1024
"""Below this a file is a stub or an error page, not a paper."""

PDF_MAGIC = b"%PDF-"


def safe_filename(value: str, max_length: int = 120) -> str:
    """Reduce *value* to something every filesystem will accept."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value or "paper")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._") or "paper"
    return cleaned[:max_length].rstrip(" .")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_pdf_bytes(body: bytes | None) -> bool:
    """True if *body* looks like a PDF payload rather than HTML or an error."""
    return bool(body) and body.lstrip()[:5].startswith(PDF_MAGIC)


def validate_pdf(path: Path) -> None:
    """Raise ValueError unless *path* is a plausible, non-truncated PDF."""
    if not path.is_file():
        raise ValueError(f"not a valid PDF: file does not exist: {path}")
    with path.open("rb") as handle:
        signature = handle.read(5)
    if signature != PDF_MAGIC:
        raise ValueError(f"not a valid PDF: bad signature: {path}")
    if path.stat().st_size < MIN_PDF_BYTES:
        raise ValueError(
            f"not a valid PDF: {path.stat().st_size} bytes is below the "
            f"{MIN_PDF_BYTES}-byte minimum: {path}"
        )
