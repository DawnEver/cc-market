"""PDF decomposition — one implementation for all three workflows.

Literature review needs section text and figures; manuscript review needs the
same; reviewer discovery needs only the front matter. Previously that was two
separate wrappers in two repositories which drifted apart. Here it is one module
with two entry points over the same extraction.

``paper_pdf_ingest`` is an optional extra. Without it, front-matter extraction
falls back to a conservative first-page parse, and full decomposition refuses
rather than producing something half-right.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from academia.core import log
from academia.core.errors import UsageError
from academia.core.text import as_text, normalize_doi

#: An abstract longer than this is almost certainly the introduction as well.
ABSTRACT_WORD_LIMIT = 500

_ABSTRACT_START = re.compile(r"\babstract\b[\s—:.-]*", re.IGNORECASE)
_ABSTRACT_END = re.compile(
    r"\b(index terms|keywords|key words|i\.\s+introduction|1\.\s+introduction)\b", re.IGNORECASE
)
_KEYWORDS = re.compile(
    r"\b(?:index terms|keywords|key words)\b[\s—:.-]*(.+?)(?:\n\s*\n|$)",
    re.IGNORECASE | re.DOTALL,
)
_DOI = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+\b", re.IGNORECASE)


def _has_ingest() -> bool:
    import importlib.util

    return importlib.util.find_spec("paper_pdf_ingest") is not None


@dataclass
class Decomposed:
    """Full decomposition: sections, figures and the assembled entry point."""

    root: Path
    entry: Path
    sections: list[Path]
    images: list[Path]


def decompose(pdf: Path, out_dir: Path) -> Decomposed:
    """Split a PDF into per-section markdown and extracted images.

    Used by literature review and manuscript review. Requires the ``pdf`` extra:
    a partial decomposition is worse than none, because downstream steps treat
    the presence of an output directory as proof the work was done.
    """
    if not _has_ingest():
        raise UsageError(
            "PDF decomposition requires the 'pdf' extra: uv sync --extra pdf"
        )
    from paper_pdf_ingest import ingest  # type: ignore[import-not-found]

    out_dir.mkdir(parents=True, exist_ok=True)
    ingest(str(pdf), str(out_dir))  # pragma: no cover - exercised by the extra
    entry = out_dir / "paper.md"
    return Decomposed(
        root=out_dir,
        entry=entry,
        sections=sorted((out_dir / "md").glob("*.md")) if (out_dir / "md").exists() else [],
        images=sorted((out_dir / "img").rglob("*.png")) if (out_dir / "img").exists() else [],
    )


# ------------------------------------------------------------ front matter


def _first_page_text(pdf: Path) -> str:
    """Extract page-one text with whatever reader is available."""
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        try:
            import fitz  # type: ignore[import-not-found]
        except ImportError as exc:
            raise UsageError(
                "no PDF reader available. Install the 'pdf' extra, or pass "
                "--title/--abstract directly."
            ) from exc
        with fitz.open(pdf) as document:  # pragma: no cover - depends on extra
            return str(document[0].get_text())
    reader = PdfReader(str(pdf))  # pragma: no cover - depends on extra
    return str(reader.pages[0].extract_text() or "")


def parse_front_matter(text: str) -> dict[str, object]:
    """Pull title, abstract, keywords and DOI out of first-page text.

    Everything here is best-effort and visibly so: a caller that gets an empty
    title should be told to supply one, not handed a heading that happened to be
    in a large font.
    """
    lines = [line.strip() for line in (text or "").splitlines()]
    non_empty = [line for line in lines if line]

    title = ""
    for line in non_empty[:8]:
        # Titles are long-ish and not all caps headers or running heads.
        if len(line.split()) >= 4 and not line.isupper():
            title = line
            break

    abstract = ""
    match = _ABSTRACT_START.search(text or "")
    if match:
        tail = text[match.end() :]
        end = _ABSTRACT_END.search(tail)
        abstract = tail[: end.start()] if end else tail[:3000]
        abstract = " ".join(abstract.split())

    keywords: list[str] = []
    keyword_match = _KEYWORDS.search(text or "")
    if keyword_match:
        raw = " ".join(keyword_match.group(1).split())
        keywords = [k.strip(" .;") for k in re.split(r"[,;]", raw) if k.strip(" .;")]

    doi_match = _DOI.search(text or "")
    return {
        "title": title,
        "abstract": abstract,
        "keywords": keywords[:12],
        "doi": normalize_doi(doi_match.group(0)) if doi_match else "",
    }


def extract_front_matter(pdf: Path):
    """Build a :class:`~academia.reviewer.profile.Sanitized` record from a PDF.

    This is the only path by which manuscript content enters the system, and it
    deliberately yields a narrow record: title, abstract, keywords. Body text is
    not extracted here at all, so no later mistake can leak it.
    """
    from academia.reviewer.profile import Sanitized

    parsed = parse_front_matter(_first_page_text(pdf))
    title = as_text(parsed["title"])
    abstract = as_text(parsed["abstract"])

    if not title:
        raise UsageError(
            f"could not read a title from {pdf.name}. Re-run with --title (and --abstract)."
        )
    if len(abstract.split()) > ABSTRACT_WORD_LIMIT:
        log.warn(
            "the extracted abstract is unusually long; it may have absorbed the "
            "introduction. Check 1-manuscript/sanitized.json before continuing."
        )
        abstract = " ".join(abstract.split()[:ABSTRACT_WORD_LIMIT])

    return Sanitized(
        title=title,
        abstract=abstract,
        keywords=list(parsed["keywords"]),  # type: ignore[arg-type]
    )
