"""The seam between a scholarly source and the review workspace.

Sources return :class:`~academia.core.models.Paper`. The literature-review
workspace has its own on-disk record — ``candidate.jsonl`` — carrying the
provenance of *how* a paper was found: which query, which page, which rank.
That is workspace bookkeeping, not a property of the paper, so the conversion
lives here rather than inside every source.

Previously each provider implemented its own ``normalize_record``, which meant
four copies of the same field mapping drifting apart.
"""

from __future__ import annotations

from typing import Any

from academia.core.models import Paper

ARTIFACT_VERSION = 1


def candidate_from_paper(
    paper: Paper,
    *,
    query_id: str,
    rank: int,
    page: int,
    search_expression: str,
) -> dict[str, Any]:
    """Convert one search hit into a workspace candidate record."""
    candidate: dict[str, Any] = {
        "artifact_version": ARTIFACT_VERSION,
        "candidate_id": _candidate_id(paper, query_id, rank),
        "source_provider": paper.source,
        "query_id": query_id,
        "page": page,
        "rank": rank,
        "search_expression": search_expression,
        "title": paper.title,
        "abstract": paper.abstract,
        "doi": paper.doi,
        "venue": paper.venue,
        "content_type": paper.venue_type,
        "html_url": paper.url,
        "pdf_url": paper.pdf_url,
        "provider_raw": {"source_id": paper.source_id},
    }
    if paper.year is not None:
        candidate["publication_year"] = paper.year
    if paper.citation_count is not None:
        candidate["citation_count"] = paper.citation_count
    if paper.authors:
        candidate["authors"] = [author.name for author in paper.authors]
    if paper.terms:
        candidate["terms"] = [term for term, _kind, _score in paper.terms]
    return candidate


def _candidate_id(paper: Paper, query_id: str, rank: int) -> str:
    """Human-legible id, stable across runs when the source supplies one."""
    if paper.source_id:
        return f"{paper.source.upper()}-{paper.source_id}"
    if paper.doi:
        return f"DOI-{paper.doi}"
    return f"{query_id}-{rank:04d}"
