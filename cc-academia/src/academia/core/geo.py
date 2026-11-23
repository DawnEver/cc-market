"""Country codes of affiliations: shared by manuscript intake (documents) and the referee geography rule."""

from __future__ import annotations


def normalize_country(value: str) -> str:
    return (value or "").strip().upper()[:2]


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
