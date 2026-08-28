"""Semantic Scholar — paper search, and author endpoints only with a key.

A live probe settled the second half of that sentence: the first unauthenticated
call to ``/author/search`` came back HTTP 429. So this source contributes paper
metadata and open-access links, and its author capability activates only when
``S2_API_KEY`` is set. OpenAlex carries the author workload.
"""

from __future__ import annotations

import os
from typing import Any

from academia.core.http import build_url, get_json
from academia.core.models import Author, Paper, position_label
from academia.core.text import as_text, optional_int
from academia.sources.base import PaperSource, SearchPage

BASE_URL = "https://api.semanticscholar.org/graph/v1"
SOURCE = "semantic_scholar"

SEARCH_FIELDS = (
    "title,abstract,year,authors,venue,citationCount,externalIds,url,"
    "publicationTypes,fieldsOfStudy,openAccessPdf"
)

#: Map the shared content-type vocabulary onto S2's own.
PUBLICATION_TYPES = {"Journals": "JournalArticle", "Conferences": "Conference"}


def api_key() -> str:
    return os.environ.get("S2_API_KEY", "").strip()


def open_access_pdf(record: dict[str, Any]) -> str:
    """A direct OA link when S2 has one, else an arXiv mirror, else nothing.

    Worth extracting eagerly: without it every hit reaches the downloader with an
    empty PDF URL and has to be re-resolved by DOI.
    """
    oa = record.get("openAccessPdf")
    if isinstance(oa, dict) and oa.get("url"):
        return as_text(oa["url"])
    external = record.get("externalIds")
    arxiv_id = external.get("ArXiv") if isinstance(external, dict) else None
    return f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else ""


def to_paper(record: dict[str, Any]) -> Paper:
    raw_external = record.get("externalIds")
    external: dict[str, Any] = raw_external if isinstance(raw_external, dict) else {}
    types = record.get("publicationTypes") or []

    paper = Paper.build(
        title=as_text(record.get("title")),
        source=SOURCE,
        doi=as_text(external.get("DOI")),
        source_id=as_text(record.get("paperId")),
        abstract=as_text(record.get("abstract")),
        year=optional_int(record.get("year")),
        venue=as_text(record.get("venue")),
        venue_type=as_text(types[0]) if types else "",
        citation_count=optional_int(record.get("citationCount")),
        url=as_text(record.get("url")),
        pdf_url=open_access_pdf(record),
    )

    raw_authors = [a for a in (record.get("authors") or []) if isinstance(a, dict)]
    paper.authors = [
        Author(
            name=as_text(a.get("name")),
            idx=index,
            position=position_label(index, len(raw_authors)),
            s2_id=as_text(a.get("authorId")),
        )
        for index, a in enumerate(raw_authors)
    ]
    paper.terms = [(as_text(f), "field_of_study", None) for f in record.get("fieldsOfStudy") or []]
    return paper


class SemanticScholar(PaperSource):
    request_delay = 3.0  # the free tier allows roughly 100 requests per 5 minutes

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """S2 relevance search takes plain terms, not boolean syntax."""
        cleaned = expression.replace('"', " ")
        for operator in (" AND ", " OR ", " NOT ", "(", ")"):
            cleaned = cleaned.replace(operator, " ")
        return " ".join(cleaned.split())

    def _headers(self) -> dict[str, str]:
        key = api_key()
        return {"x-api-key": key} if key else {}

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
        content_types: list[str] | None = None,
    ) -> SearchPage:
        years = [str(y) for y in (year_from, year_to) if y]
        publication_types = ",".join(
            PUBLICATION_TYPES[c] for c in (content_types or []) if c in PUBLICATION_TYPES
        )
        url = build_url(
            f"{BASE_URL}/paper/search",
            {
                "query": self.adapt_expression(expression),
                "offset": (page - 1) * per_page,
                "limit": per_page,
                "fields": SEARCH_FIELDS,
                "year": "-".join(years) if years else None,
                "publicationTypes": publication_types or None,
            },
        )
        data = get_json(url, SOURCE, headers=self._headers(), timeout=timeout)
        records = [r for r in (data.get("data") or []) if isinstance(r, dict)]
        return SearchPage(
            source=SOURCE,
            query_id=query_id,
            page=page,
            total_count=optional_int(data.get("total")) or len(records),
            papers=[to_paper(r) for r in records],
            raw=data,
        )
