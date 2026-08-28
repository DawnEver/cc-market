"""DBLP — computer science bibliography.

Complete for CS venues and effectively unlimited, but metadata-only: no
abstracts, no affiliations. It contributes venue coverage, not depth.
"""

from __future__ import annotations

from typing import Any

from academia.core.http import build_url, get_json
from academia.core.models import Author, Paper, position_label
from academia.core.text import as_text, optional_int
from academia.sources.base import PaperSource, SearchPage

BASE_URL = "https://dblp.org/search/publ/api"
SOURCE = "dblp"


def _venue_type(url: str) -> str:
    lowered = (url or "").lower()
    if "/journals/" in lowered:
        return "Journal"
    if "/conf/" in lowered:
        return "Conference"
    return ""


def _authors(info: dict[str, Any]) -> list[str]:
    """DBLP returns a bare object for single-author papers and a list otherwise."""
    raw = info.get("authors")
    entries = raw.get("author") if isinstance(raw, dict) else raw
    if isinstance(entries, dict):
        entries = [entries]
    if not isinstance(entries, list):
        return []
    names = []
    for entry in entries:
        names.append(as_text(entry.get("text")) if isinstance(entry, dict) else as_text(entry))
    return [n for n in names if n]


def to_paper(record: dict[str, Any]) -> Paper:
    raw_info = record.get("info")
    info: dict[str, Any] = raw_info if isinstance(raw_info, dict) else {}
    url = as_text(info.get("url"))
    is_open = as_text(info.get("access")) == "open"

    paper = Paper.build(
        title=as_text(info.get("title")).rstrip("."),
        source=SOURCE,
        doi=as_text(info.get("doi")),
        source_id=as_text(info.get("key")),
        year=optional_int(info.get("year")),
        venue=as_text(info.get("venue")),
        venue_type=_venue_type(url),
        url=url,
        pdf_url=as_text(info.get("ee")) if is_open else "",
    )
    names = _authors(info)
    paper.authors = [
        Author(name=name, idx=index, position=position_label(index, len(names)))
        for index, name in enumerate(names)
    ]
    return paper


class Dblp(PaperSource):
    request_delay = 1.0

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """DBLP treats a space as AND and has no OR; strip what it cannot honour."""
        cleaned = expression.replace('"', " ").replace("(", " ").replace(")", " ")
        cleaned = cleaned.replace(" AND ", " ").replace(" OR ", " ").replace(" NOT ", " ")
        return " ".join(cleaned.split())

    def search(
        self,
        expression: str,
        query_id: str,
        *,
        page: int = 1,
        per_page: int = 25,
        year_from: int | None = None,
        year_to: int | None = None,
        timeout: int = 30,
    ) -> SearchPage:
        url = build_url(
            BASE_URL,
            {
                "q": self.adapt_expression(expression),
                "f": (page - 1) * per_page,
                "h": per_page,
                "format": "json",
            },
        )
        data = get_json(url, SOURCE, timeout=timeout)
        hits = (data.get("result") or {}).get("hits") or {}
        records = [h for h in (hits.get("hit") or []) if isinstance(h, dict)]
        papers = [to_paper(r) for r in records]

        # DBLP offers no server-side year filter.
        if year_from or year_to:
            papers = [
                p
                for p in papers
                if p.year is not None
                and (not year_from or p.year >= year_from)
                and (not year_to or p.year <= year_to)
            ]

        return SearchPage(
            source=SOURCE,
            query_id=query_id,
            page=page,
            total_count=optional_int(hits.get("@total")) or len(papers),
            papers=papers,
            raw=data,
        )
