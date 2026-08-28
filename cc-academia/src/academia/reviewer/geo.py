"""Geographic separation between a submission and its reviewers.

Operates on the candidate's **current affiliation country**, never on nationality
and never on anything inferred from a name. A Chinese researcher now at Stanford
counts as US, which is both more accurate and avoids profiling reviewers by
ethnicity — a proxy that is unreliable and that an editor could not defend.

Default behaviour is a soft preference: cross-region candidates gain a small
bonus rather than same-region candidates being deleted. A journal that genuinely
requires exclusion can switch ``geo.mode`` to ``hard_filter``.
"""

from __future__ import annotations

from dataclasses import dataclass

from academia.core.models import Person
from academia.reviewer.policy import Policy

MODE_PREFER = "prefer_cross_region"
MODE_HARD = "hard_filter"
MODE_OFF = "off"


@dataclass(frozen=True)
class GeoAssessment:
    candidate_country: str
    origin_countries: tuple[str, ...]
    cross_region: bool
    bonus: float
    excluded: bool
    reason: str

    def describe(self) -> str:
        if not self.candidate_country:
            return "country unknown; no geographic preference applied"
        origins = ", ".join(self.origin_countries) or "unknown"
        relation = "different from" if self.cross_region else "same as"
        return f"{self.candidate_country} — {relation} the submission ({origins})"


def normalize_country(value: str) -> str:
    return (value or "").strip().upper()[:2]


def assess(person: Person, origin_countries: list[str], policy: Policy) -> GeoAssessment:
    """Score a candidate's geographic relationship to the submission."""
    origins = tuple(sorted({normalize_country(c) for c in origin_countries if c}))
    country = normalize_country(person.country_code)
    mode = policy.geo_mode

    if mode == MODE_OFF or not origins:
        return GeoAssessment(country, origins, False, 0.0, False, "geographic preference disabled")

    if not country:
        # Unknown affiliation must not be punished — it is a data gap, not a fact
        # about the reviewer.
        return GeoAssessment(country, origins, False, 0.0, False, "candidate country unknown")

    cross = country not in origins
    if mode == MODE_HARD:
        return GeoAssessment(
            country,
            origins,
            cross,
            0.0,
            excluded=not cross,
            reason="hard geographic filter" if not cross else "cross-region",
        )

    return GeoAssessment(
        country,
        origins,
        cross,
        policy.geo_bonus if cross else 0.0,
        False,
        "cross-region bonus" if cross else "same region as submission",
    )


def origin_countries_from(affiliations: list[str], countries: list[str]) -> list[str]:
    """Derive the submission's origin countries from its author affiliations."""
    explicit = [normalize_country(c) for c in countries if normalize_country(c)]
    if explicit:
        return sorted(set(explicit))
    # Fall back to a crude affiliation scan only when no country was supplied.
    return sorted({c for c in (_country_hint(a) for a in affiliations) if c})


#: Minimal hints for the common case where only a free-text affiliation is known.
#: Deliberately small: a wrong guess here is worse than an unknown.
_HINTS = {
    "china": "CN",
    "chinese": "CN",
    "beijing": "CN",
    "shanghai": "CN",
    "tsinghua": "CN",
    "zhejiang": "CN",
    "usa": "US",
    "united states": "US",
    "u.s.a": "US",
    "united kingdom": "GB",
    "england": "GB",
    "scotland": "GB",
    "germany": "DE",
    "japan": "JP",
    "korea": "KR",
    "singapore": "SG",
    "italy": "IT",
    "france": "FR",
    "spain": "ES",
    "canada": "CA",
    "australia": "AU",
    "india": "IN",
}


def _country_hint(affiliation: str) -> str:
    lowered = (affiliation or "").lower()
    for needle, code in _HINTS.items():
        if needle in lowered:
            return code
    return ""
