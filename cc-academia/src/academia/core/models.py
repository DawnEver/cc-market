"""Domain records shared by every workflow.

The old ``models.py`` mixed retrieval candidates with workspace run state, so a
change to one dragged the other along. Here the split is explicit: this module
holds only things that exist in the world (papers, people, institutions), while
run state belongs to the workflow that owns it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from academia.core.text import normalize_doi, normalize_name, normalize_orcid, normalize_title

#: Author-position weights. Different fields order authors differently, so a
#: reviewer search must not restrict itself to first/second authors — it weights
#: them. Corresponding authors count as much as first authors when the flag is
#: actually present, which for OpenAlex is rare.
POSITION_WEIGHTS = {
    "first": 1.0,
    "second": 0.8,
    "last": 0.8,
    "middle": 0.4,
    "other": 0.4,
}
CORRESPONDING_WEIGHT = 1.0


def utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def stable_id(prefix: str, *parts: Any) -> str:
    """Deterministic short id so re-running a pipeline does not fork the store."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return f"{prefix}-{digest[:16]}"


def position_label(idx: int, total: int) -> str:
    """Map a 0-based author index onto a position label.

    OpenAlex only distinguishes first/middle/last, but second authors carry real
    signal in engineering venues, so the index is what we trust.
    """
    if idx == 0:
        return "first"
    if idx == 1 and total > 2:
        return "second"
    if idx == total - 1 and total > 1:
        return "last"
    return "middle"


def position_weight(position: str, *, is_corresponding: bool = False) -> float:
    if is_corresponding:
        return CORRESPONDING_WEIGHT
    return POSITION_WEIGHTS.get(position, POSITION_WEIGHTS["other"])


@dataclass(slots=True)
class Institution:
    inst_id: str
    name: str
    ror_id: str = ""
    country_code: str = ""
    city: str = ""
    type: str = ""

    @classmethod
    def build(cls, name: str, *, ror_id: str = "", **kwargs: Any) -> Institution:
        key = ror_id or normalize_title(name)
        return cls(inst_id=stable_id("inst", key), name=name, ror_id=ror_id, **kwargs)


#: Institution kinds ranked by how likely they are to be where someone actually
#: works. OpenAlex marks several institutions "current" for a prolific author,
#: and a funder or a provincial education department is not an employer.
EMPLOYER_PRIORITY = {
    "education": 0,
    "facility": 1,
    "healthcare": 2,
    "company": 3,
    "nonprofit": 4,
    "government": 5,
    "funder": 6,
    "archive": 7,
    "other": 8,
}


@dataclass(slots=True)
class Affiliation:
    inst_id: str
    institution: str = ""
    country_code: str = ""
    department: str = ""
    role: str = ""
    year_from: int | None = None
    year_to: int | None = None
    is_current: bool = False
    source: str = ""
    source_url: str = ""
    kind: str = ""

    @property
    def employer_rank(self) -> int:
        return EMPLOYER_PRIORITY.get(self.kind, EMPLOYER_PRIORITY["other"])


@dataclass(slots=True)
class Education:
    inst_id: str
    institution: str = ""
    degree: str = ""
    field: str = ""
    year_from: int | None = None
    year_to: int | None = None
    advisor_person_id: str = ""
    source: str = ""
    source_url: str = ""


@dataclass(slots=True)
class Author:
    """One author slot on one paper, before identity resolution."""

    name: str
    idx: int
    position: str = "middle"
    is_corresponding: bool = False
    orcid: str = ""
    openalex_id: str = ""
    ieee_author_id: str = ""
    s2_id: str = ""
    raw_affiliation: str = ""
    country_code: str = ""

    def __post_init__(self) -> None:
        self.orcid = normalize_orcid(self.orcid)

    @property
    def weight(self) -> float:
        return position_weight(self.position, is_corresponding=self.is_corresponding)

    @property
    def name_key(self) -> str:
        return normalize_name(self.name)


@dataclass(slots=True)
class Paper:
    """A published work, normalised across sources."""

    paper_id: str
    title: str
    source: str
    doi: str = ""
    abstract: str = ""
    year: int | None = None
    venue: str = ""
    venue_type: str = ""
    citation_count: int | None = None
    source_id: str = ""
    url: str = ""
    pdf_url: str = ""
    landing_page_url: str = ""
    authors: list[Author] = field(default_factory=list)
    terms: list[tuple[str, str, float | None]] = field(default_factory=list)
    referenced_ids: list[str] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.doi = normalize_doi(self.doi)

    @classmethod
    def build(cls, *, title: str, source: str, doi: str = "", source_id: str = "", **kwargs: Any) -> Paper:
        clean_doi = normalize_doi(doi)
        # Identity precedence: DOI, then the source's own id, then the title.
        # A title-only key is weak, so it is the last resort rather than the default.
        key = clean_doi or (f"{source}:{source_id}" if source_id else normalize_title(title))
        return cls(
            paper_id=stable_id("paper", key),
            title=title,
            source=source,
            doi=clean_doi,
            source_id=source_id,
            **kwargs,
        )

    def to_row(self) -> dict[str, Any]:
        now = utcnow()
        return {
            "paper_id": self.paper_id,
            "doi": self.doi or None,
            "title": self.title,
            "abstract": self.abstract or None,
            "year": self.year,
            "venue": self.venue or None,
            "venue_type": self.venue_type or None,
            "citation_count": self.citation_count,
            "source": self.source,
            "source_id": self.source_id or None,
            "url": self.url or None,
            "pdf_url": self.pdf_url or None,
            "landing_page_url": self.landing_page_url or None,
            "first_seen": now,
            "last_seen": now,
        }


#: Affiliation sources that state where someone works, rather than inferring it
#: from where their papers were written. Both carry a URL or an explicit
#: attestation, so a correction stays as checkable as the thing it replaces.
VERIFIED_AFFILIATION_SOURCES = frozenset({"agent_lookup", "editor_attestation"})


@dataclass(slots=True)
class Person:
    """A resolved researcher identity.

    ``resolution_method`` and ``confidence`` travel with the record because a
    low-confidence match must be visible in the final report, not silently
    presented as fact.
    """

    person_id: str
    display_name: str
    orcid: str = ""
    openalex_id: str = ""
    ieee_author_id: str = ""
    s2_id: str = ""
    confidence: float = 0.0
    resolution_method: str = "unresolved"
    names: list[str] = field(default_factory=list)
    affiliations: list[Affiliation] = field(default_factory=list)
    education: list[Education] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    stated_rank: str = ""
    rank_source: str = ""
    #: Works published per year, as the bibliographic profile reports it —
    #: the whole record, not the papers one run happened to harvest.
    works_by_year: dict[int, int] = field(default_factory=dict)

    @property
    def rank(self) -> str:
        """Most senior academic rank stated anywhere in the career history.

        A career record holds every post someone ever held and the doctorate is
        usually the oldest entry, so taking the most senior avoids reporting a
        professor as a PhD student. Never inferred from output: no publication
        count promotes anybody.
        """
        from academia.reviewer.seniority import best_rank, rank_from_title

        # A supplied rank was read off a page by someone and carries its source.
        # It is authoritative, so it wins outright rather than competing on
        # seniority — otherwise a PhD candidate whose only ORCID employment is
        # an industry post gets reported as an engineer.
        if self.stated_rank:
            return self.stated_rank
        academic = [a for a in self._titled_affiliations if a.employer_rank == 0]
        considered = academic or self._titled_affiliations
        return best_rank([rank_from_title(a.role) for a in considered])

    @property
    def _titled_affiliations(self) -> list[Affiliation]:
        """Affiliations that state a role, academic employers first.

        Many academics also hold a post at a spin-off, and ORCID lists both.
        Reading the company title would report an associate professor as an
        engineer, which is the opposite of what an editor needs.
        """
        from academia.reviewer.seniority import clean_title

        titled = [a for a in self.affiliations if clean_title(a.role)]
        return sorted(titled, key=lambda a: (a.employer_rank, not a.is_current))

    @property
    def stated_title(self) -> str:
        """The raw job title a source gave, whether or not it maps to a rank.

        Reporting "Research Assistant" as unknown throws away a real answer.
        Unknown should mean nobody stated anything.
        """
        from academia.reviewer.seniority import clean_title

        for affiliation in self._titled_affiliations:
            if (title := clean_title(affiliation.role)):
                return title
        return ""

    @property
    def current_affiliation(self) -> Affiliation | None:
        """Where this person most plausibly works now.

        Among the affiliations marked current, prefer a university over a funder
        or a government body; then, between two universities, the one held
        longest. OpenAlex marks several as current for a prolific author, and
        the primary employer is the long-running one, not whichever a recent
        collaboration added.
        """
        current = [a for a in self.affiliations if a.is_current]
        # A correction someone read off the person's own staff page, with the
        # URL recorded, outranks anything a bibliographic database inferred. An
        # author index can attach a researcher to an institution they never
        # worked at, and the country it implies then feeds the geographic score.
        verified = [a for a in current if a.source in VERIFIED_AFFILIATION_SOURCES]
        if verified:
            return max(verified, key=lambda a: (a.year_to or a.year_from or 0))
        if current:
            return min(
                current,
                key=lambda a: (a.employer_rank, -(a.year_to or 0), a.year_from or 9999),
            )
        dated = [a for a in self.affiliations if a.year_to or a.year_from]
        if not dated:
            return self.affiliations[0] if self.affiliations else None
        return max(dated, key=lambda a: (a.year_to or a.year_from or 0, -a.employer_rank))

    @property
    def country_code(self) -> str:
        affiliation = self.current_affiliation
        return affiliation.country_code if affiliation else ""

    @property
    def phd_year(self) -> int | None:
        for entry in self.education:
            if re.search(r"ph\.?\s?d|doctor", entry.degree or "", re.IGNORECASE):
                return entry.year_to or entry.year_from
        return None

    def academic_age(self, now_year: int) -> int | None:
        year = self.phd_year
        return None if year is None else max(0, now_year - year)

    @property
    def _doctoral_education(self) -> Education | None:
        for entry in self.education:
            if re.search(r"ph\.?\s?d|doctor", entry.degree or "", re.IGNORECASE):
                return entry
        return None

    def doctoral_year(self, now_year: int) -> int | None:
        """Which year of doctoral study this person is in, or ``None``.

        Counted inclusively from the enrolment year, so someone who started in
        ``now_year`` is in year 1. ``None`` means no start year is stated
        anywhere — a gap in public data, never evidence that someone is junior.
        """
        entry = self._doctoral_education
        if entry is None or not entry.year_from:
            return None
        return max(1, now_year - entry.year_from + 1)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
