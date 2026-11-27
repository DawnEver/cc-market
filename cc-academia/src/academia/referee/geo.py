"""Geographic separation between a submission and its reviewers.

Operates on the candidate's **current affiliation country**, never on nationality
and never on anything inferred from a name. A Chinese researcher now at Stanford
counts as US, which is both more accurate and avoids profiling reviewers by
ethnicity — a proxy that is unreliable and that an editor could not defend.

Default behaviour is a soft preference: a cross-region candidate scores higher
rather than a same-region candidate being deleted. A journal that genuinely
requires exclusion can switch ``geo.mode`` to ``hard_filter``.

How *much* higher is not stated here. It is ``scoring.geographic``, the weight
the component carries like every other component. This module used to compute a
``bonus`` from a second config key that said the same thing — and nothing ever
read it, so a journal that tuned ``geo.bonus`` changed nothing at all.
"""

from __future__ import annotations

from dataclasses import dataclass

from academia.core.geo import normalize_country
from academia.core.models import Person
from academia.referee.policy import Policy

MODE_PREFER = "prefer_cross_region"
MODE_HARD = "hard_filter"
MODE_OFF = "off"


@dataclass(frozen=True)
class GeoAssessment:
    candidate_country: str
    origin_countries: tuple[str, ...]
    cross_region: bool
    excluded: bool
    reason: str

    def describe(self) -> str:
        if not self.candidate_country:
            return "country unknown; no geographic preference applied"
        origins = ", ".join(self.origin_countries) or "unknown"
        relation = "different from" if self.cross_region else "same as"
        return f"{self.candidate_country} — {relation} the submission ({origins})"


def assess(person: Person, origin_countries: list[str], policy: Policy) -> GeoAssessment:
    """Score a candidate's geographic relationship to the submission."""
    origins = tuple(sorted({normalize_country(c) for c in origin_countries if c}))
    country = normalize_country(person.country_code)
    mode = policy.geo_mode

    if mode == MODE_OFF or not origins:
        return GeoAssessment(country, origins, False, False, "geographic preference disabled")

    if not country:
        # Unknown affiliation must not be punished — it is a data gap, not a fact
        # about the reviewer.
        return GeoAssessment(country, origins, False, False, "candidate country unknown")

    cross = country not in origins
    if mode == MODE_HARD:
        return GeoAssessment(
            country,
            origins,
            cross,
            excluded=not cross,
            reason="hard geographic filter" if not cross else "cross-region",
        )

    return GeoAssessment(
        country,
        origins,
        cross,
        False,
        "cross-region" if cross else "same region as submission",
    )
