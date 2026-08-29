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

_SEP = r"[\s\u2014\u2013\ufffd:.-]*"
_ABSTRACT_START = re.compile(r"\babstract\b" + _SEP, re.IGNORECASE)
_ABSTRACT_END = re.compile(
    r"\b(index terms|keywords|key words|i\.\s+introduction|1\.\s+introduction)\b", re.IGNORECASE
)
_KEYWORDS = re.compile(
    r"\b(?:index terms|keywords|key words)\b" + _SEP + r"(.+?)(?:\n\s*\n|$)",
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


def cover_page_count(page_texts: list[str]) -> int:
    """How many leading pages are an editorial cover sheet rather than the paper.

    Atypon ReX and similar systems prepend a submission cover: a title, the
    author list, and headings like "Submission ID" and "Files for Peer Review".
    A section splitter cannot tell that from a paper and happily decomposes the
    cover instead — a live TTE submission produced exactly those three sections
    and nothing from the manuscript. The page carrying the abstract is where the
    paper starts; if no page has one, assume there is no cover rather than
    guessing a number.
    """
    for index, text in enumerate(page_texts):
        if _ABSTRACT_START.search(text or ""):
            return index
    return 0


def _without_cover_pages(pdf: Path, out_dir: Path) -> Path:
    """The PDF with any editorial cover removed, or the original untouched."""
    try:
        import pymupdf  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover - depends on optional extra
        return pdf

    with pymupdf.open(pdf) as document:  # pragma: no cover - depends on extra
        texts = [
            str(document[i].get_text())
            for i in range(min(FRONT_MATTER_SCAN_PAGES, document.page_count))
        ]
        skip = cover_page_count(texts)
        if not skip:
            return pdf
        trimmed = out_dir / "_without-cover.pdf"
        document.select(list(range(skip, document.page_count)))
        document.save(trimmed)
    log.detail(f"skipped {skip} cover page(s) before decomposition")
    return trimmed


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
    # paper_pdf_ingest exposes the stages, not a single entry point: convert
    # picks the extraction tool and yields markdown, split_sections finds the
    # section boundaries, write_paper_output lays out paper.md, md/ and img/.
    from paper_pdf_ingest import (  # type: ignore[import-not-found]
        convert,
        split_sections,
        write_paper_output,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    source = _without_cover_pages(pdf, out_dir)
    markdown, _tool = convert(source, out_dir)  # pragma: no cover - exercised by the extra
    sections = split_sections(markdown)
    write_paper_output(sections, out_dir, markdown, pdf_path=pdf)
    entry = out_dir / "paper.md"
    return Decomposed(
        root=out_dir,
        entry=entry,
        sections=sorted((out_dir / "md").glob("*.md")) if (out_dir / "md").exists() else [],
        images=sorted((out_dir / "img").rglob("*.png")) if (out_dir / "img").exists() else [],
    )


# ------------------------------------------------------------ front matter


#: How far into a submission to look for the real front matter. Editorial systems
#: prepend a cover sheet; a title page plus a cover is the realistic worst case.
FRONT_MATTER_SCAN_PAGES = 5

#: An IEEE title runs to about 20 words. Beyond this the join has escaped into
#: the page rather than found a longer title.
TITLE_WORD_LIMIT = 30

#: Titles wrap onto a second or third line. A fourth is the parser losing track.
_TITLE_MAX_LINES = 3

#: Lines that end the title rather than continue it. A front page frequently has
#: neither a blank line nor a membership byline after the title, and without
#: these the join walks the author list and the affiliations straight into the
#: abstract — carrying body text past the one command allowed to read it.
_BYLINE = re.compile(r"\b(member|fellow|student member),?\s+ieee\b", re.IGNORECASE)
_AFFILIATION = re.compile(
    r"\b(universit|institute|department|school of|college|laborator|academy"
    r"|centre|center|gmbh|ltd)\b",
    re.IGNORECASE,
)
#: "Liming Liu, Lingyun Shao, and Wei Hua" — a comma-separated list, or any line
#: carrying a contact marker.
_CONTACT = re.compile(r"@|\bemail\b", re.IGNORECASE)
#: Case-sensitive on purpose: the trailing run must be *capitalised* names.
#: Case-folded, this would also truncate "Design, analysis and control".
_AUTHOR_LIST = re.compile(r",\s*(?:and\s+)?(?:[A-Z][\w.'-]*\s*){1,3}$")
#: A sentence that closes mid-line is prose, not a wrapped title.
_PROSE = re.compile(r"[.!?]\s+\S")


def _ends_the_title(line: str) -> bool:
    """Whether ``line`` terminates the title instead of continuing it."""
    return bool(
        _ABSTRACT_START.match(line)
        or _BYLINE.search(line)
        or _AFFILIATION.search(line)
        or _CONTACT.search(line)
        or _AUTHOR_LIST.search(line)
        or _PROSE.search(line)
    )


def select_front_matter_page(pages: list[str]) -> int:
    """Index of the page holding the paper's own front matter.

    Editorial systems (Atypon ReX and friends) prepend a submission cover sheet
    that repeats the title in a form no parser should trust: wrapped, prefixed
    with "Regular Paper", and with no abstract behind it. The page that carries
    the abstract is the paper's. Falling back to page one keeps the old
    behaviour for PDFs that have no cover.
    """
    for index, text in enumerate(pages):
        if _ABSTRACT_START.search(text or ""):
            return index
    return 0


def _page_texts(pdf: Path, limit: int) -> list[str]:
    """Extract text for the first ``limit`` pages with whatever reader exists."""
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        try:
            import pymupdf  # type: ignore[import-not-found]
        except ImportError as exc:
            raise UsageError(
                "no PDF reader available. Install the 'pdf' extra, or pass "
                "--title/--abstract directly."
            ) from exc
        with pymupdf.open(pdf) as document:  # pragma: no cover - depends on extra
            return [str(document[i].get_text()) for i in range(min(limit, document.page_count))]
    reader = PdfReader(str(pdf))  # pragma: no cover - depends on extra
    return [str(page.extract_text() or "") for page in reader.pages[:limit]]


def _read_title(lines: list[str]) -> str:
    """Read the title, re-joining the lines a two-column layout wrapped it across.

    A 24pt title that spills onto three lines arrives as three entries here, and
    taking only the first truncates it mid-clause — which then searches as a
    different paper. Continuation lines are the contiguous non-empty ones that
    follow, stopping at the byline, the abstract, or a blank line.
    """
    parts: list[str] = []
    for index, line in enumerate(lines[:8]):
        # Titles are long-ish and not all caps headers or running heads.
        if len(line.split()) >= 4 and not line.isupper() and not _ends_the_title(line):
            parts.append(line)
            for follow in lines[index + 1 :]:
                if not follow or _ends_the_title(follow):
                    break
                parts.append(follow)
                if len(parts) >= _TITLE_MAX_LINES:
                    break
            break
    if not parts:
        return ""
    # A hyphen at a wrap point belongs to the word, not between the words.
    joined = parts[0]
    for part in parts[1:]:
        joined = joined.rstrip()
        joined = joined + part if joined.endswith("-") else f"{joined} {part}"
    return " ".join(joined.split()[:TITLE_WORD_LIMIT])


def parse_front_matter(text: str) -> dict[str, object]:
    """Pull title, abstract, keywords and DOI out of first-page text.

    Everything here is best-effort and visibly so: a caller that gets an empty
    title should be told to supply one, not handed a heading that happened to be
    in a large font.
    """
    lines = [line.strip() for line in (text or "").splitlines()]

    title = _read_title(lines)

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

    pages = _page_texts(pdf, FRONT_MATTER_SCAN_PAGES)
    parsed = parse_front_matter(pages[select_front_matter_page(pages)] if pages else "")
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
