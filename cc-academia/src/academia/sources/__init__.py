"""Scholarly data sources.

A factory table rather than a chain of ``if`` branches: the entries import
lazily, so a command that never searches does not pay for the HTTP stack, and a
test can substitute a source by replacing one dict entry.
"""

from __future__ import annotations

from collections.abc import Callable

from academia.core.errors import UsageError
from academia.sources.base import AuthorSource, PaperSource, Probe, SearchPage

__all__ = [
    "AUTHOR_SOURCE_FACTORIES",
    "SOURCE_FACTORIES",
    "SOURCE_NAMES",
    "AuthorSource",
    "PaperSource",
    "Probe",
    "SearchPage",
    "get_author_source",
    "get_source",
]


def _openalex() -> PaperSource:
    from academia.sources.openalex import OpenAlex

    return OpenAlex()


def _ieee() -> PaperSource:
    from academia.sources.ieee import IeeeXplore

    return IeeeXplore()


def _semantic_scholar() -> PaperSource:
    from academia.sources.semantic_scholar import SemanticScholar

    return SemanticScholar()


def _arxiv() -> PaperSource:
    from academia.sources.arxiv import ArXiv

    return ArXiv()


def _dblp() -> PaperSource:
    from academia.sources.dblp import Dblp

    return Dblp()


def _orcid() -> AuthorSource:
    from academia.sources.orcid import Orcid

    return Orcid()


#: Canonical name -> factory. Aliases resolve separately so this stays a clean
#: list of the sources that actually exist.
SOURCE_FACTORIES: dict[str, Callable[[], PaperSource]] = {
    "openalex": _openalex,
    "ieee": _ieee,
    "semantic_scholar": _semantic_scholar,
    "arxiv": _arxiv,
    "dblp": _dblp,
}

#: Search order for a multi-source run: richest metadata first.
SOURCE_NAMES = tuple(SOURCE_FACTORIES)

#: Author-capable sources. Semantic Scholar is deliberately absent — its author
#: endpoints answer an unauthenticated request with HTTP 429, so it cannot be a
#: default. OpenAlex carries this workload.
AUTHOR_SOURCE_FACTORIES: dict[str, Callable[[], AuthorSource]] = {
    "openalex": _openalex,  # type: ignore[dict-item]
    "orcid": _orcid,
}

_ALIASES = {
    "oa": "openalex",
    "ieee_xplore": "ieee",
    "s2": "semantic_scholar",
    "semanticscholar": "semantic_scholar",
}


def _canonical(name: str) -> str:
    key = (name or "").strip().lower()
    return _ALIASES.get(key, key)


def get_source(name: str) -> PaperSource:
    """Resolve a search source by name.

    An unknown name is an error rather than a silent fallback: quietly searching
    the wrong index spends a rate-limit budget and returns a plausible, wrong
    answer.
    """
    factory = SOURCE_FACTORIES.get(_canonical(name))
    if factory is None:
        raise UsageError(
            f"unknown source '{name}'. Available: {', '.join(sorted(SOURCE_FACTORIES))}"
        )
    return factory()


def get_author_source(name: str) -> AuthorSource:
    factory = AUTHOR_SOURCE_FACTORIES.get(_canonical(name))
    if factory is None:
        raise UsageError(
            f"unknown author source '{name}'. "
            f"Available: {', '.join(sorted(AUTHOR_SOURCE_FACTORIES))}"
        )
    return factory()
