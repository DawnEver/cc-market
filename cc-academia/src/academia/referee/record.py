"""Everything the rules know about one candidate, derived once.

A rule is a predicate over a handful of quantities: how long this person has
been publishing, how much they have published lately, and how much of that is
on this manuscript's topic and in a journal. Each of those is one question with
one answer.

Before this module every rule derived its own. Two of them derived career
length, from two different sources — the run's harvest and the person's own
publication profile — and disagreed for 158 of 197 candidates on a live case,
by as much as 28 years, in adjacent columns of the same spreadsheet. Worse, the
one that read the harvest was a *preference* for early-career reviewers, so a
32-year veteran collected the early-career bonus because the search happened to
find only his recent papers. The rule was measuring the search, not the person.

So the quantities live here, each with exactly one derivation, and every rule
reads them. Two properties are load-bearing:

**Profile before harvest.** A person's own bibliographic profile is a statement
about them; the papers this run stored are a statement about this run's
queries. Where both exist the profile wins, and ``source`` records which was
used so a weaker basis is visible in the audit rather than implied.

**A gap stays a gap.** Nothing here substitutes a zero for a missing record.
``career_years`` is ``None`` when no year is known, and a rule that receives
``None`` abstains rather than judging.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from academia.core.models import Person
from academia.store import repository as repo

#: Where a publication record came from. A profile is the person's own output as
#: a bibliographic source reports it; a harvest is only what this run's queries
#: brought back, which answers a narrower question and says so.
PROFILE = "profile"
HARVEST = "harvest"
NONE = "none"


@dataclass(frozen=True)
class PublicationRecord:
    """One person's output over time, and where the numbers came from."""

    #: Works per year. From the profile this is a count; from the harvest it is
    #: the number of that year's papers this run happens to hold.
    by_year: dict[int, int] = field(default_factory=dict)
    source: str = NONE

    @property
    def known(self) -> bool:
        return bool(self.by_year)

    @property
    def first_year(self) -> int | None:
        return min(self.by_year) if self.by_year else None

    @property
    def latest_year(self) -> int | None:
        years = [year for year, works in self.by_year.items() if works]
        return max(years) if years else None

    def count_since(self, floor: int, now_year: int) -> int:
        return sum(w for year, w in self.by_year.items() if floor <= year <= now_year)

    def career_years(self, now_year: int) -> int | None:
        """Years of publishing, inclusive of the first year. ``None`` if unknown.

        The single definition. A rule that wants "years since the doctorate"
        asks :meth:`CandidateRecord.seniority` instead, which prefers a stated
        doctorate year and falls back to this.
        """
        first = self.first_year
        return None if first is None else now_year - first + 1

    @classmethod
    def build(
        cls, works_by_year: dict[int, int], harvested_years: list[int], now_year: int
    ) -> PublicationRecord:
        profile = {
            int(year): int(works)
            for year, works in (works_by_year or {}).items()
            if int(year) <= now_year
        }
        if profile:
            return cls(by_year=profile, source=PROFILE)
        harvest: dict[int, int] = {}
        for year in harvested_years or []:
            if year is not None and int(year) <= now_year:
                harvest[int(year)] = harvest.get(int(year), 0) + 1
        return cls(by_year=harvest, source=HARVEST if harvest else NONE)


#: How a seniority figure was arrived at. Reported, because "eight years since
#: the doctorate" and "eight years of publishing" are different claims and an
#: editor reading a borderline candidate is entitled to know which one they got.
FROM_DOCTORATE = "doctorate"
FROM_FIRST_PAPER = "first publication"


@dataclass(frozen=True)
class Seniority:
    years: int | None
    basis: str
    #: The year the count started from, so the figure can be checked.
    since: int | None = None


@dataclass(frozen=True)
class RelevantRecord:
    """The evidence that qualified this candidate for *this* manuscript.

    Necessarily the run's own corpus rather than a profile: "has this person
    published on this topic" is a question only the run's relevance judgement
    can answer. Kept separate from :class:`PublicationRecord` so no rule can
    reach for one while meaning the other.
    """

    papers: tuple[Any, ...] = ()

    @property
    def years(self) -> list[int]:
        return [p.year for p in self.papers if getattr(p, "year", None)]

    def count_since(self, floor: int, now_year: int) -> int:
        return sum(1 for year in self.years if floor <= year <= now_year)

    @property
    def latest_year(self) -> int | None:
        years = [year for year in self.years if year]
        return max(years) if years else None


@dataclass(frozen=True)
class CandidateRecord:
    """One candidate, as the rules see them."""

    person: Person
    now_year: int
    publications: PublicationRecord = field(default_factory=PublicationRecord)
    relevant: RelevantRecord = field(default_factory=RelevantRecord)

    @property
    def seniority(self) -> Seniority:
        """Position on the one seniority axis, however it can be established.

        A stated doctorate year is the better basis and is preferred; ORCID
        carries one for a minority of researchers in this field, so the
        publication record is the fallback. Both are years-since-a-start, which
        is why they are one figure and not two rules.
        """
        if (year := self.person.phd_year) is not None:
            return Seniority(max(0, self.now_year - year), FROM_DOCTORATE, year)
        first = self.publications.first_year
        if first is None:
            return Seniority(None, FROM_FIRST_PAPER, None)
        return Seniority(self.now_year - first + 1, FROM_FIRST_PAPER, first)

    @classmethod
    def build(
        cls,
        conn: sqlite3.Connection,
        person: Person,
        *,
        relevant_papers: list[Any] | None = None,
        now_year: int,
    ) -> CandidateRecord:
        return cls(
            person=person,
            now_year=now_year,
            publications=PublicationRecord.build(
                person.works_by_year or repo.output_by_year(conn, person.person_id),
                repo.publication_years(conn, person.person_id),
                now_year,
            ),
            relevant=RelevantRecord(tuple(relevant_papers or ())),
        )
