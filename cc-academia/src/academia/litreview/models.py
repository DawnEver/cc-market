"""Data models for Literature Review — replaces all JSON Schema files."""

from __future__ import annotations

import dataclasses
import types
import typing
from dataclasses import asdict, dataclass, field
from functools import cache
from typing import Any, get_args, get_origin, get_type_hints

# ---------------------------------------------------------------------------
# Serialization base — typed round-trip across JSON boundaries
# ---------------------------------------------------------------------------

@cache
def _class_hints(cls: type) -> dict[str, Any]:
    """Resolved type hints per class, cached — from_dict runs per record."""
    return get_type_hints(cls)


def _coerce(tp: Any, value: Any):
    """Coerce a JSON value toward the annotated field type (best effort)."""
    origin = get_origin(tp)
    if origin in (typing.Union, types.UnionType):
        # Models only use `X | None`; coerce against the sole non-None member
        for arg in get_args(tp):
            if arg is not type(None):
                return _coerce(arg, value)
        return value
    if origin is list and isinstance(value, list):
        (sub,) = get_args(tp) or (Any,)
        return [_coerce(sub, v) for v in value]
    if dataclasses.is_dataclass(tp) and isinstance(value, dict):
        return tp.from_dict(value)  # type: ignore[union-attr]
    if tp is int and not isinstance(value, bool):
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    if tp is float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    return value


class Serde:
    """Mixin: tolerant dict round-trip for dataclass models.

    ``from_dict`` ignores unknown keys, applies field defaults for missing or
    null values, and rebuilds nested dataclasses (including inside lists).
    """

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)  # type: ignore[call-overload]

    @classmethod
    def from_dict(cls, data: dict[str, Any]):
        hints = _class_hints(cls)
        kwargs: dict[str, Any] = {}
        missing: list[str] = []
        for f in dataclasses.fields(cls):
            # type: ignore[arg-type]
            if f.name not in data or data[f.name] is None:
                # Let the field default apply; required fields have none
                if (f.default is dataclasses.MISSING
                        and f.default_factory is dataclasses.MISSING):
                    missing.append(f.name)
                continue
            kwargs[f.name] = _coerce(hints.get(f.name, Any), data[f.name])
        if missing:
            raise ValueError(
                f"{cls.__name__}.from_dict: required field(s) missing or null: "
                + ", ".join(missing)
            )
        return cls(**kwargs)


# ---------------------------------------------------------------------------
# Shared primitives
# ---------------------------------------------------------------------------

@dataclass
class Approval(Serde):
    approved: bool = False
    approved_at: str | None = None
    approved_by: str | None = None
    hash: str | None = None  # research_scope_sha256 / queries_sha256 / screening_sha256


# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------

@dataclass
class ZoteroBinding(Serde):
    """Flat collection per workspace — no nested subcollections in Zotero.

    Principles:
      - One workspace → one Zotero collection (flat, human-readable).
      - The workspace slug is the collection name by default.
      - Tags are used for cross-cutting labels (e.g. "to-read", "key-paper").
      - The zotero_registry.jsonl file is the single source of truth for
        workspace↔Zotero linkage.
    """
    collection_key: str = ""
    collection_name: str = ""   # derived from workspace slug; populated by init/sync
    group_id: str | None = None
    sync_notes: bool = True
    sync_attachments: bool = True   # PDFs are the primary reason for Zotero
    tags: list[str] = field(default_factory=list)


@dataclass
class ZoteroRegistryEntry(Serde):
    """One row in a workspace's zotero_registry.jsonl — bridges workspace ↔ Zotero."""
    candidate_id: str
    zotero_key: str          # 8-char Zotero item key
    title: str = ""
    doi: str = ""
    date_synced: str = ""    # ISO timestamp
    pdf_attached: bool = False
    notes_synced: bool = False
    zotero_collection: str = ""  # collection name this entry lives in


@dataclass
class WorkspaceConstraints(Serde):
    year_from: int = 2018
    year_to: int = 2026
    content_types: list[str] = field(default_factory=lambda: ["Journals", "Conferences"])
    preferred_venues: list[str] = field(default_factory=list)


@dataclass
class Workspace(Serde):
    workspace_id: str
    name: str
    description: str = ""
    created_at: str = ""
    zotero: ZoteroBinding = field(default_factory=ZoteroBinding)
    defaults: WorkspaceConstraints = field(default_factory=WorkspaceConstraints)
    lenses: list[str] = field(default_factory=list)
    providers: list[str] = field(default_factory=lambda: ["ieee_xplore"])
    pdf_store: str = ""
    parent: str = ""


# ---------------------------------------------------------------------------
# Research Brief
# ---------------------------------------------------------------------------

@dataclass
class Concept(Serde):
    concept_id: str
    role: str  # must | should | context | evidence | exclude
    term: str
    synonyms: list[str] = field(default_factory=list)
    rationale: str = ""
    source: str = "user"
    selected: bool = True


@dataclass
class ResearchBrief(Serde):
    brief_id: str
    original_request: str
    research_objective: str
    inclusion_criteria: list[str] = field(default_factory=list)
    exclusion_criteria: list[str] = field(default_factory=list)
    year_from: int = 2018
    year_to: int = 2026
    content_types: list[str] = field(default_factory=lambda: ["Journals", "Conferences"])
    preferred_venues: list[str] = field(default_factory=list)
    concepts: list[Concept] = field(default_factory=list)
    approval: Approval | None = None
    topic_id: str = ""
    created_at: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["constraints"] = {
            "year_from": d.pop("year_from"),
            "year_to": d.pop("year_to"),
            "content_types": d.pop("content_types"),
            "preferred_venues": d.pop("preferred_venues"),
        }
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ResearchBrief:
        # Accept both the flat layout and the nested 'constraints' layout
        constraints = data.get("constraints")
        if isinstance(constraints, dict):
            data = {**data, **{k: constraints[k] for k in
                               ("year_from", "year_to", "content_types", "preferred_venues")
                               if k in constraints}}
        return super().from_dict(data)


# ---------------------------------------------------------------------------
# Candidate & Screening
# ---------------------------------------------------------------------------

@dataclass
class Candidate(Serde):
    candidate_id: str
    source_provider: str
    title: str
    abstract: str = ""
    doi: str = ""
    authors: list[str] = field(default_factory=list)
    venue: str = ""
    publication_year: int | None = None
    content_type: str = ""
    keywords: list[str] = field(default_factory=list)
    citation_count: int = 0
    html_url: str = ""
    pdf_url: str = ""
    provider_raw: dict[str, Any] = field(default_factory=dict)
    query_id: str = ""
    page: int = 1
    rank: int = 0
    search_expression: str = ""


@dataclass
class ScreeningDecision(Serde):
    candidate_id: str
    decision: str  # include | maybe | exclude
    confidence: float = 0.0
    inclusion_reasons: list[str] = field(default_factory=list)
    exclusion_reasons: list[str] = field(default_factory=list)
    uncertainties: list[str] = field(default_factory=list)
    abstract_available: bool = True
    download_priority: str = "medium"  # none | low | medium | high


# ---------------------------------------------------------------------------
# Query Plan
# ---------------------------------------------------------------------------

@dataclass
class QueryItem(Serde):
    query_id: str
    purpose: str
    provider: str = "ieee_xplore"
    expression: str = ""
    year_from: int = 2018
    year_to: int = 2026
    content_types: list[str] = field(default_factory=lambda: ["Journals", "Conferences"])
    sort: str = "relevance"
    enabled: bool = True
    concept_ids: list[str] = field(default_factory=list)


@dataclass
class QueryPlan(Serde):
    queries: list[QueryItem] = field(default_factory=list)
    brief_ref: dict[str, str] = field(default_factory=dict)
    approval: Approval | None = None


# ---------------------------------------------------------------------------
# Download & Ingest manifests
# ---------------------------------------------------------------------------

@dataclass
class DownloadItem(Serde):
    candidate_id: str
    title: str
    pdf_path: str = ""
    sha256: str = ""
    pdf_bytes: int = 0
    acquisition_method: str = ""
    acquired_at: str = ""
    screening_reason: str = ""
    reading_questions: list[str] = field(default_factory=list)


@dataclass
class DownloadManifest(Serde):
    manifest_id: str
    run_id: str
    papers: list[DownloadItem] = field(default_factory=list)
    approved_brief_sha256: str = ""


@dataclass
class IngestItem(Serde):
    candidate_id: str
    pdf_path: str
    output_path: str
    status: str = "failed"  # succeeded | failed | skipped
    error: str = ""
    paper_md: str = ""
    index_md: str = ""
    page_markdown: list[str] = field(default_factory=list)
    figures: list[dict] = field(default_factory=list)


@dataclass
class IngestManifest(Serde):
    source_manifest: str
    source_manifest_sha256: str = ""
    confirmed_by_user: bool = False
    ingests: list[IngestItem] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Paper Card (deep reading output)
# ---------------------------------------------------------------------------

@dataclass
class Evidence(Serde):
    claim: str
    source: str = ""    # path to markdown file
    locator: str = ""   # e.g. "Fig. 8, Table II"


@dataclass
class ResearchUse(Serde):
    type: str  # adapt | compare | baseline | cite | discard
    note: str = ""


@dataclass
class PaperCard(Serde):
    candidate_id: str
    title: str
    verdict: str = "targeted-read"  # deep-read | targeted-read | archive
    confidence: float = 0.0
    one_sentence: str = ""
    technical_core: list[str] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    research_use: list[ResearchUse] = field(default_factory=list)
    next_action: str = ""
    open_questions: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Reading Queue
# ---------------------------------------------------------------------------

@dataclass
class ScoreBreakdown(Serde):
    relevance: int = 0
    methodology: int = 0
    novelty: int = 0
    evidence: int = 0


@dataclass
class QueueItem(Serde):
    candidate_id: str
    title: str
    verdict: str = "targeted-read"
    confidence: float = 0.0
    scores: ScoreBreakdown = field(default_factory=ScoreBreakdown)
    reason: str = ""
    first_target: str = ""


@dataclass
class ReadingQueue(Serde):
    research_need: str
    papers: list[QueueItem] = field(default_factory=list)
    top_picks: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
