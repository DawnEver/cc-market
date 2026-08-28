"""Turn a submission into a search profile.

This module owns the confidentiality boundary, and it owns it *inside the tool*
rather than delegating it to the host. Codex may not support the same hook system
as Claude Code, so a permission rule is a second lock, never the only one:

* ``ingest`` reads the raw PDF and writes ``sanitized.json``
* every other command, and every command that prints, reads only the sanitized file
* the sanitized file carries title, abstract, keywords and author metadata — the
  things an editor would put in a reviewer invitation — and never the body text

Search queries sent to external APIs are derived keywords, not the abstract.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import Any

from academia.core.errors import UsageError
from academia.core.text import as_text, tokenize
from academia.reviewer.workspace import Workspace, title_hash

#: Fields allowed out of the manuscript. Anything else stays in the PDF.
SANITIZED_FIELDS = ("title", "abstract", "keywords", "authors", "journal", "year", "references")


@dataclass
class ManuscriptAuthor:
    name: str
    affiliation: str = ""
    country: str = ""
    orcid: str = ""


@dataclass
class Sanitized:
    """The only representation of a submission that may reach a model."""

    title: str
    abstract: str
    keywords: list[str] = field(default_factory=list)
    authors: list[ManuscriptAuthor] = field(default_factory=list)
    journal: str = ""
    year: int = 0
    reference_titles: list[str] = field(default_factory=list)
    reference_dois: list[str] = field(default_factory=list)

    @property
    def title_hash(self) -> str:
        return title_hash(self.title)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "abstract": self.abstract,
            "keywords": self.keywords,
            "authors": [asdict(a) for a in self.authors],
            "journal": self.journal,
            "year": self.year,
            "reference_titles": self.reference_titles,
            "reference_dois": self.reference_dois,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Sanitized:
        return cls(
            title=as_text(data.get("title")),
            abstract=as_text(data.get("abstract")),
            keywords=[as_text(k) for k in data.get("keywords") or []],
            authors=[
                ManuscriptAuthor(
                    name=as_text(a.get("name")),
                    affiliation=as_text(a.get("affiliation")),
                    country=as_text(a.get("country")).upper(),
                    orcid=as_text(a.get("orcid")),
                )
                for a in data.get("authors") or []
            ],
            journal=as_text(data.get("journal")),
            year=int(data.get("year") or 0),
            reference_titles=[as_text(t) for t in data.get("reference_titles") or []],
            reference_dois=[as_text(d) for d in data.get("reference_dois") or []],
        )


@dataclass
class Query:
    query_id: str
    expression: str
    rationale: str = ""


@dataclass
class Profile:
    """Search profile derived from the sanitized record."""

    manuscript_id: str
    title_hash: str
    journal: str
    year: int
    primary_topics: list[str] = field(default_factory=list)
    methods: list[str] = field(default_factory=list)
    application_domains: list[str] = field(default_factory=list)
    queries: list[Query] = field(default_factory=list)
    origin_countries: list[str] = field(default_factory=list)
    author_names: list[str] = field(default_factory=list)
    author_institutions: list[str] = field(default_factory=list)
    reference_dois: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["queries"] = [asdict(q) for q in self.queries]
        return payload

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Profile:
        profile = cls(
            manuscript_id=as_text(data.get("manuscript_id")),
            title_hash=as_text(data.get("title_hash")),
            journal=as_text(data.get("journal")),
            year=int(data.get("year") or 0),
            primary_topics=list(data.get("primary_topics") or []),
            methods=list(data.get("methods") or []),
            application_domains=list(data.get("application_domains") or []),
            origin_countries=list(data.get("origin_countries") or []),
            author_names=list(data.get("author_names") or []),
            author_institutions=list(data.get("author_institutions") or []),
            reference_dois=list(data.get("reference_dois") or []),
        )
        profile.queries = [
            Query(
                query_id=as_text(q.get("query_id")),
                expression=as_text(q.get("expression")),
                rationale=as_text(q.get("rationale")),
            )
            for q in data.get("queries") or []
        ]
        return profile


# ------------------------------------------------------------------ ingest


def ingest_pdf(pdf: Path) -> Sanitized:
    """Extract the citable front matter from a manuscript PDF.

    Delegates to ``paper_pdf_ingest`` when the ``pdf`` extra is installed. Without
    it the caller must supply the metadata by hand — guessing at a title from raw
    bytes would be worse than asking.
    """
    try:
        from academia.ingest.pdf import extract_front_matter
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise UsageError(
            "PDF ingest requires the 'pdf' extra: uv sync --extra pdf\n"
            "Alternatively supply --title/--abstract directly."
        ) from exc
    return extract_front_matter(pdf)


def write_sanitized(workspace: Workspace, sanitized: Sanitized) -> Path:
    return workspace.write_json(workspace.sanitized_path, sanitized.to_dict())


def load_sanitized(workspace: Workspace) -> Sanitized:
    return Sanitized.from_dict(workspace.read_json(workspace.sanitized_path))


# ----------------------------------------------------------------- profile


#: Method vocabulary common in IEEE power/electrical submissions. Used by the
#: deterministic fallback so the pipeline runs without any model configured.
_METHOD_HINTS = (
    "finite element",
    "optimization",
    "model predictive control",
    "reinforcement learning",
    "machine learning",
    "neural network",
    "observer",
    "sensorless",
    "topology",
    "modulation",
    "thermal analysis",
    "co-simulation",
    "analytical model",
    "experimental validation",
)


def _keyword_phrases(sanitized: Sanitized) -> list[str]:
    """Author keywords first; they are the most reliable signal in a submission."""
    phrases = [k.strip() for k in sanitized.keywords if k.strip()]
    if phrases:
        return phrases
    # Fall back to the most frequent content bigrams of the title and abstract.
    tokens = tokenize(f"{sanitized.title} {sanitized.abstract}")
    counts: dict[str, int] = {}
    for a, b in pairwise(tokens):
        counts[f"{a} {b}"] = counts.get(f"{a} {b}", 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [phrase for phrase, count in ranked[:8] if count > 1] or tokens[:8]


def _methods(sanitized: Sanitized) -> list[str]:
    haystack = f"{sanitized.title} {sanitized.abstract}".lower()
    return [hint for hint in _METHOD_HINTS if hint in haystack]


def build_queries(topics: list[str], methods: list[str]) -> list[Query]:
    """Compose boolean expressions from the profile.

    Broad first, then narrower pairings. Sources that lack boolean grammar strip
    the operators themselves, so the expression stays source-agnostic here.
    """
    queries: list[Query] = []
    if topics:
        primary = " AND ".join(f'"{t}"' for t in topics[:2])
        queries.append(Query("q1", primary, "primary topics, both required"))
    for index, topic in enumerate(topics[:4], start=2):
        queries.append(Query(f"q{index}", f'"{topic}"', f"single topic: {topic}"))
    for index, method in enumerate(methods[:2], start=len(queries) + 1):
        anchor = topics[0] if topics else ""
        expression = f'"{anchor}" AND "{method}"' if anchor else f'"{method}"'
        queries.append(Query(f"q{index}", expression, f"method pairing: {method}"))
    return queries


def build_profile(sanitized: Sanitized, *, manuscript_id: str, journal: str = "") -> Profile:
    """Derive a searchable profile deterministically.

    A model can refine this later, but the pipeline must produce a usable profile
    with no model configured at all — reviewer discovery should not be blocked on
    an API key.
    """
    from academia.reviewer.geo import origin_countries_from

    topics = _keyword_phrases(sanitized)
    methods = _methods(sanitized)
    institutions = [a.affiliation for a in sanitized.authors if a.affiliation]

    return Profile(
        manuscript_id=manuscript_id,
        title_hash=sanitized.title_hash,
        journal=journal or sanitized.journal,
        year=sanitized.year,
        primary_topics=topics[:6],
        methods=methods,
        application_domains=[],
        queries=build_queries(topics[:6], methods),
        origin_countries=origin_countries_from(
            institutions, [a.country for a in sanitized.authors]
        ),
        author_names=[a.name for a in sanitized.authors if a.name],
        author_institutions=institutions,
        reference_dois=sanitized.reference_dois,
    )


def assert_no_body_text(payload: dict[str, Any]) -> None:
    """Guard against a caller widening the sanitized record by accident.

    The confidentiality promise is only as strong as the narrowest gate; this is
    that gate, and it is inside the tool so it holds on any host.
    """
    allowed = {
        "title",
        "abstract",
        "keywords",
        "authors",
        "journal",
        "year",
        "reference_titles",
        "reference_dois",
    }
    extra = set(payload) - allowed
    if extra:
        raise UsageError(
            "sanitized record contains fields that must not leave the manuscript: "
            + ", ".join(sorted(extra))
        )


def redact_for_search(profile: Profile) -> list[str]:
    """Exactly what leaves the machine: derived keyword expressions, nothing else."""
    return [q.expression for q in profile.queries]


_WORD_BOUNDARY = re.compile(r"\W+")


def looks_like_body_text(value: str, *, word_limit: int = 400) -> bool:
    """Heuristic tripwire for an abstract field that has swallowed a section."""
    return len([w for w in _WORD_BOUNDARY.split(value or "") if w]) > word_limit
