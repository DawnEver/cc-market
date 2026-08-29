"""Auditable institutional history, kept separate from current geography.

An institution is evidence about a researcher's career, not their ethnicity or
nationality. Current employment, previous employment and education therefore
remain distinct instead of being collapsed into one country label.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from academia.core.models import Person


@dataclass(frozen=True, slots=True)
class InstitutionStep:
    institution: str
    kind: str
    country: str = ""
    year_from: int | None = None
    year_to: int | None = None
    source: str = ""
    source_url: str = ""

    @property
    def years(self) -> str:
        values = [str(value) for value in (self.year_from, self.year_to) if value]
        return "–".join(values) if values else "dates unknown"


def build(person: Person) -> list[InstitutionStep]:
    """Return a de-duplicated, categorised institutional trajectory."""
    current = person.current_affiliation
    steps: list[InstitutionStep] = []
    seen: set[tuple[str, str, int | None, int | None]] = set()
    for affiliation in person.affiliations:
        if affiliation is current:
            kind = "current"
        elif affiliation.source == "orcid":
            kind = "employment"
        else:
            # OpenAlex derives these from paper affiliations. They show a
            # historical institutional link, not necessarily employment.
            kind = "publication affiliation"
        key = (affiliation.inst_id, kind, affiliation.year_from, affiliation.year_to)
        if key in seen:
            continue
        seen.add(key)
        steps.append(
            InstitutionStep(
                institution=affiliation.institution or "institution unknown",
                kind=kind,
                country=affiliation.country_code,
                year_from=affiliation.year_from,
                year_to=affiliation.year_to,
                source=affiliation.source,
                source_url=affiliation.source_url,
            )
        )
    for education in person.education:
        key = (education.inst_id, "education", education.year_from, education.year_to)
        if key in seen:
            continue
        seen.add(key)
        steps.append(
            InstitutionStep(
                institution=education.institution or "institution unknown",
                kind="education",
                year_from=education.year_from,
                year_to=education.year_to,
                source=education.source,
                source_url=education.source_url,
            )
        )
    order = {"current": 0, "employment": 1, "education": 2, "publication affiliation": 3}
    return sorted(steps, key=lambda step: (order[step.kind], -(step.year_to or 0), step.institution))


def history_text(person: Person, *, limit: int = 3) -> str:
    """Compact prior-employment/education evidence for the shortlist."""
    history = [step for step in build(person) if step.kind != "current"]
    if not history:
        return "not recorded"
    rendered = [f"{step.kind}: {step.institution} ({step.years})" for step in history[:limit]]
    if len(history) > limit:
        rendered.append(f"+{len(history) - limit} more")
    return "; ".join(rendered)


def country_exposure(people: list[Person], *, historical: bool) -> Counter[str]:
    """Count people with current or historical country evidence, once each."""
    counts: Counter[str] = Counter()
    for person in people:
        countries = {
            step.country
            for step in build(person)
            if step.country and ((step.kind != "current") == historical)
        }
        counts.update(countries)
    return counts


def quality_note(person: Person) -> str:
    """Surface unusually broad bibliographic histories instead of trusting them."""
    publication_links = [step for step in build(person) if step.kind == "publication affiliation"]
    if len(publication_links) > 20:
        return (
            f"{len(publication_links)} historical publication affiliations; "
            "identity/affiliation history requires verification"
        )
    return ""
