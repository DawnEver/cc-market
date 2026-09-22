"""Source capability interfaces.

Two capabilities, deliberately separate, because live probing showed no source
has both well:

* :class:`PaperSource` — search the literature. IEEE has the best relevance for
  its own venues but returns neither affiliations nor index terms.
* :class:`AuthorSource` — resolve and enrich people. OpenAlex is the primary here
  (ROR-linked institutions, country codes, affiliation year series); Semantic
  Scholar's author endpoints return HTTP 429 on the very first unauthenticated
  call, so they are a keyed extra rather than a dependency.

The old ``PaperSource`` also declared ``acquire()``, which every implementation
raised ``NotImplementedError`` for. PDF acquisition is a transport concern and
lives in ``litreview.acquire``, not on a search interface.
"""

from __future__ import annotations

import inspect
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from academia.core.models import Paper, Person


def accepted_search_kwargs(source: PaperSource) -> frozenset[str] | None:
    """The keyword names ``source.search`` accepts; ``None`` means "anything".

    Read from the real signature because the bug this serves *is* drift between
    a generic caller and five concrete signatures: the caller forwarded
    ``content_types`` to every provider, and the three that never declared it
    raised ``TypeError`` on every query that carried one. A hand-kept list of
    accepted names is a second copy of the signature, and it goes stale the
    first time someone adds a parameter.

    ``None`` and ``frozenset()`` mean different things and must not be
    conflated: the first is "accepts anything" (a ``**kwargs`` source), the
    second would be "accepts nothing".
    """
    parameters = inspect.signature(source.search).parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return None
    return frozenset(parameters)


@dataclass(frozen=True)
class SearchPage:
    """One page of results, still in source-native shape."""

    source: str
    query_id: str
    page: int
    total_count: int
    papers: list[Paper]
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Probe:
    """A cheap page-one look, used to judge a query before spending on it."""

    source: str
    query_id: str
    total_count: int
    sample_titles: list[str]
    failure_reason: str | None = None
    failure_status: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def is_account_failure(self) -> bool:
        """Whether this failure will repeat for every remaining query.

        The distinction that changes what a run should do. ``is_transient``
        answers a different question — "would retrying this help?" — and 429 is
        transient by that measure, which is exactly why its answer must not be
        reused here: a spent quota is a wall, not a burst.
        """
        from academia.core.http import ACCOUNT_STATUSES

        return self.failure_status in ACCOUNT_STATUSES


class PaperSource(ABC):
    """A searchable literature index."""

    #: Politeness delay between requests, seconds.
    request_delay: float = 0.5
    #: Attempts per page; only transient failures consume one.
    max_retries: int = 3

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
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
    ) -> SearchPage: ...

    def adapt_expression(self, expression: str) -> str:
        """Translate a generic boolean expression into this source's syntax.

        Pass-through by default (IEEE-style boolean); sources with a different
        grammar override it.
        """
        return expression

    def probe(self, expression: str, query_id: str, **kwargs: Any) -> Probe:
        """Default probe: a single small page. Sources with a count-only endpoint override.

        A failure comes back as a value, not an exception: judging a query
        against a dead source is still an answer about the query. The caller is
        then responsible for recording *which* answer it got — a probe that
        reports ``total_count=0`` without its ``failure_reason`` is
        indistinguishable from a query that genuinely matched nothing.
        """
        from academia.core.errors import SourceError
        from academia.core.http import error_status

        # Deliberately not wrapped in with_retries, unlike search_pages. A probe
        # is one small page, and the failure it most often reports is an
        # exhausted quota, which is persistent: retrying it three times per
        # query across a fifty-query plan spends the budget it just ran out of.
        try:
            page = self.search(expression, query_id, page=1, per_page=5, **kwargs)
        except SourceError as error:
            return Probe(
                self.name,
                query_id,
                0,
                [],
                failure_reason=error.reason,
                failure_status=error_status(error),
            )
        return Probe(
            source=self.name,
            query_id=query_id,
            total_count=page.total_count,
            sample_titles=[p.title for p in page.papers[:5]],
            raw=page.raw,
        )

    def search_pages(
        self,
        expression: str,
        query_id: str,
        *,
        max_pages: int = 5,
        per_page: int = 25,
        **kwargs: Any,
    ) -> list[SearchPage]:
        """Walk pages until the source runs out or the budget does."""
        from academia.core.http import with_retries

        pages: list[SearchPage] = []
        for number in range(1, max_pages + 1):
            page = with_retries(
                self.search,
                expression,
                query_id,
                attempts=self.max_retries,
                base_delay=self.request_delay or 1.0,
                page=number,
                per_page=per_page,
                **kwargs,
            )
            pages.append(page)
            if len(page.papers) < per_page:
                break
            if number < max_pages and self.request_delay:
                time.sleep(self.request_delay)
        return pages


class AuthorSource(ABC):
    """A source that can answer questions about people rather than papers."""

    request_delay: float = 0.2

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def get_author(self, author_id: str, *, timeout: int = 30) -> Person | None:
        """Fetch a profile by this source's own identifier."""

    def find_author_by_orcid(self, orcid: str, *, timeout: int = 30) -> Person | None:
        """Optional: locate a person from an ORCID. Returns None when unsupported."""
        return None

    def get_author_papers(
        self, author_id: str, *, limit: int = 50, timeout: int = 30
    ) -> list[Paper]:
        """Optional: recent works by this author."""
        return []

