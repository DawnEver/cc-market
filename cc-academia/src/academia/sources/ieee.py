"""IEEE Xplore search.

Best-in-class relevance for IEEE venues, and the only source that hands back a
stable IEEE author identifier for free. What it does *not* return, verified by
live probe against the live endpoint:

* no author affiliations — institutions and countries must come from OpenAlex
* no index terms / thesaurus terms — controlled vocabulary comes from OpenAlex too

This is the site's own REST endpoint rather than the licensed metadata API, so it
is used at query time only. Nothing but identifiers and derived scores is
persisted, and the accumulating store is built around CC0 OpenAlex records
instead.
"""

from __future__ import annotations

import json
from typing import Any

from academia.core.errors import SourceError
from academia.core.http import BROWSER_USER_AGENT, post_json
from academia.core.models import Author, Paper, position_label
from academia.core.text import as_text, optional_int
from academia.sources.base import PaperSource, SearchPage

SEARCH_URL = "https://ieeexplore.ieee.org/rest/search"
BASE_URL = "https://ieeexplore.ieee.org"
SOURCE = "ieee"

#: The endpoint answers a bot check with a 200 and an HTML body, so a successful
#: status code is not enough to trust the payload.
_BOT_MARKERS = ("captcha", "robot check", "bot check", "verify you are human")
_LOGIN_MARKERS = ("institutional sign", "sign in to continue")


def _absolute(value: Any) -> str:
    text = as_text(value)
    if not text:
        return ""
    if text.startswith(("http://", "https://")):
        return text
    return BASE_URL + ("" if text.startswith("/") else "/") + text


def _guard(data: dict[str, Any], raw: str) -> None:
    """Reject bot-check and login pages that arrive dressed as a 200."""
    if "records" in data or "totalRecords" in data or "breadCrumbs" in data:
        return
    lowered = raw.lower()
    if any(marker in lowered for marker in _BOT_MARKERS):
        raise SourceError("captcha_or_bot_check", SOURCE)
    if any(marker in lowered for marker in _LOGIN_MARKERS):
        raise SourceError("login_required", SOURCE)
    raise SourceError("unexpected_payload", SOURCE)


def _authors_from(record: dict[str, Any]) -> list[Author]:
    raw = record.get("authors")
    if not isinstance(raw, list):
        return []
    total = len(raw)
    authors: list[Author] = []
    for idx, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        authors.append(
            Author(
                name=as_text(entry.get("preferredName") or entry.get("normalizedName")),
                idx=idx,
                position=position_label(idx, total),
                # The one thing IEEE gives away that nobody else does.
                ieee_author_id=as_text(entry.get("id")),
            )
        )
    return authors


def to_paper(record: dict[str, Any]) -> Paper:
    article_number = as_text(record.get("articleNumber") or record.get("arnumber"))
    paper = Paper.build(
        title=as_text(record.get("articleTitle") or record.get("title")),
        source=SOURCE,
        doi=as_text(record.get("doi")),
        source_id=article_number,
        abstract=as_text(record.get("abstract")),
        year=optional_int(record.get("publicationYear")),
        venue=as_text(record.get("publicationTitle") or record.get("displayPublicationTitle")),
        venue_type=as_text(record.get("contentType") or record.get("articleContentType")),
        citation_count=optional_int(record.get("citationCount")),
        url=_absolute(record.get("htmlLink") or record.get("documentLink")),
        pdf_url=_absolute(record.get("pdfLink")),
    )
    paper.authors = _authors_from(record)
    return paper


class IeeeXplore(PaperSource):
    request_delay = 1.0

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """Translate the shared Boolean profile into IEEE's plain query text.

        IEEE returns zero results for quoted phrases that return results when
        sent as plain terms. Its endpoint applies its own relevance semantics,
        so carrying OpenAlex's quotes and operators across is destructive.
        """
        cleaned = expression.replace('"', " ")
        for operator in (" AND ", " OR ", " NOT ", "(", ")"):
            cleaned = cleaned.replace(operator, " ")
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
        content_types: list[str] | None = None,
        sort: str | None = None,
        search_field: str = "All Metadata",
    ) -> SearchPage:
        payload: dict[str, Any] = {
            "queryText": self.adapt_expression(expression),
            "newsearch": True,
            "pageNumber": page,
            "rowsPerPage": per_page,
            "searchField": search_field,
        }
        if year_from and year_to:
            payload["ranges"] = [f"{year_from}_{year_to}_Year"]
        if content_types:
            payload["refinements"] = [f"ContentType:{value}" for value in content_types]
        if sort:
            payload["sortType"] = sort

        data, raw = post_json(
            SEARCH_URL,
            payload,
            SOURCE,
            headers={
                "User-Agent": BROWSER_USER_AGENT,
                "Referer": f"{BASE_URL}/search/searchresult.jsp",
                "Origin": BASE_URL,
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=timeout,
        )
        _guard(data, raw)

        records = [r for r in (data.get("records") or []) if isinstance(r, dict)]
        return SearchPage(
            source=SOURCE,
            query_id=query_id,
            page=page,
            total_count=_total(data, len(records)),
            papers=[to_paper(r) for r in records],
            raw=data,
        )


def _total(data: dict[str, Any], fallback: int) -> int:
    for key in ("totalRecords", "total", "totalfound"):
        value = data.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return fallback


def parse_search_response(raw_text: str) -> SearchPage:
    """Parse a captured response body. Used by the recorded-fixture tests."""
    data = json.loads(raw_text)
    _guard(data, raw_text)
    records = [r for r in (data.get("records") or []) if isinstance(r, dict)]
    return SearchPage(
        source=SOURCE,
        query_id="fixture",
        page=1,
        total_count=_total(data, len(records)),
        papers=[to_paper(r) for r in records],
        raw=data,
    )
