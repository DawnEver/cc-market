"""arXiv — preprints, and the most reliable open PDF link there is.

Atom XML rather than JSON, so it does not share ``core.http``'s JSON helpers;
everything else (retry policy, error taxonomy, politeness) it does.
"""

from __future__ import annotations

from typing import Any
from xml.etree import ElementTree

from academia.core.errors import SourceError
from academia.core.http import _request, build_url
from academia.core.models import Author, Paper, position_label
from academia.core.text import as_text, optional_int
from academia.sources.base import PaperSource, SearchPage

BASE_URL = "http://export.arxiv.org/api/query"
SOURCE = "arxiv"

ATOM_NS = "http://www.w3.org/2005/Atom"
OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/"
ARXIV_NS = "http://arxiv.org/schemas/atom"


def _text(element: Any, path: str, namespace: str = ATOM_NS) -> str:
    if element is None:
        return ""
    found = element.find(f"{{{namespace}}}{path}")
    return as_text(found.text) if found is not None else ""


def _arxiv_id(entry: Any) -> str:
    """``http://arxiv.org/abs/2401.01234v2`` -> ``2401.01234``."""
    raw = _text(entry, "id")
    if not raw:
        return ""
    tail = raw.rsplit("/", 1)[-1]
    return tail.split("v")[0] if "v" in tail else tail


def to_paper(entry: Any) -> Paper:
    identifier = _arxiv_id(entry)
    published = _text(entry, "published")

    pdf_url = ""
    for link in entry.findall(f"{{{ATOM_NS}}}link"):
        if link.get("title") == "pdf" or link.get("type") == "application/pdf":
            pdf_url = as_text(link.get("href"))
            break
    if not pdf_url and identifier:
        pdf_url = f"https://arxiv.org/pdf/{identifier}"

    doi_element = entry.find(f"{{{ARXIV_NS}}}doi")
    journal_ref = entry.find(f"{{{ARXIV_NS}}}journal_ref")

    paper = Paper.build(
        title=" ".join(_text(entry, "title").split()),
        source=SOURCE,
        doi=as_text(doi_element.text) if doi_element is not None else "",
        source_id=identifier,
        abstract=" ".join(_text(entry, "summary").split()),
        year=optional_int(published[:4]) if published else None,
        venue=as_text(journal_ref.text) if journal_ref is not None else "arXiv",
        venue_type="Preprint",
        url=_text(entry, "id"),
        pdf_url=pdf_url,
    )

    authors = entry.findall(f"{{{ATOM_NS}}}author")
    paper.authors = [
        Author(
            name=_text(author, "name"),
            idx=index,
            position=position_label(index, len(authors)),
        )
        for index, author in enumerate(authors)
    ]

    categories = [
        as_text(c.get("term")) for c in entry.findall(f"{{{ATOM_NS}}}category") if c.get("term")
    ]
    paper.terms = [(category, "category", None) for category in categories]
    return paper


def parse_feed(xml_text: str) -> tuple[list[Paper], int]:
    """Parse an Atom feed into papers plus the reported total."""
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as error:
        raise SourceError("malformed_xml", SOURCE) from error

    total_element = root.find(f"{{{OPENSEARCH_NS}}}totalResults")
    total = optional_int(total_element.text) if total_element is not None else None
    entries = root.findall(f"{{{ATOM_NS}}}entry")
    return [to_paper(entry) for entry in entries], total or len(entries)


class ArXiv(PaperSource):
    request_delay = 3.0  # arXiv asks for one request every three seconds

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """arXiv wants field-prefixed terms: ``all:"torque ripple"``.

        Without the prefix the API silently searches the identifier field and
        returns nothing, which reads like "no results" rather than a bad query.
        """
        cleaned = expression.strip()
        if not cleaned or ":" in cleaned.split()[0]:
            return cleaned
        return f"all:{cleaned}"

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
                "search_query": self.adapt_expression(expression),
                "start": (page - 1) * per_page,
                "max_results": per_page,
            },
        )
        body, _ = _request(url, SOURCE, headers={"Accept": "application/atom+xml"}, timeout=timeout)
        papers, total = parse_feed(body)

        # arXiv has no server-side year filter, so it is applied here.
        if year_from or year_to:
            papers = [
                p
                for p in papers
                if p.year is not None
                and (not year_from or p.year >= year_from)
                and (not year_to or p.year <= year_to)
            ]

        return SearchPage(source=SOURCE, query_id=query_id, page=page, total_count=total, papers=papers)
