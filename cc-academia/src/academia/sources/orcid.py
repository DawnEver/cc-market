"""ORCID — education and employment history.

Best-effort by design. A live sample of 40 ORCID-bearing authors in the target
domain (electrical machines, power electronics, EV traction, 2023 onward) found
the education section filled for 30% of them and employment for 38%. That makes
a career trajectory a bonus field, never a requirement: an unfilled record yields
``unknown``, never a guess.

ORCID is explicitly *not* used as an email directory. Addresses default to
private and only surface when the researcher published them themselves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from academia.core.errors import SourceError
from academia.core.http import get_json
from academia.core.models import Affiliation, Education, Institution, Person, stable_id
from academia.core.text import as_text, normalize_orcid, optional_int
from academia.sources.base import AuthorSource

BASE_URL = "https://pub.orcid.org/v3.0"
SOURCE = "orcid"


def _year(block: Any) -> int | None:
    """ORCID dates are nested ``{"year": {"value": "2015"}}`` and often absent."""
    if not isinstance(block, dict):
        return None
    year = block.get("year")
    if isinstance(year, dict):
        return optional_int(year.get("value"))
    return optional_int(year)


def _summaries(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """Flatten ORCID's ``affiliation-group -> summaries -> <key>-summary`` nesting."""
    out: list[dict[str, Any]] = []
    for group in payload.get("affiliation-group") or []:
        for summary in (group or {}).get("summaries") or []:
            entry = (summary or {}).get(key)
            if isinstance(entry, dict):
                out.append(entry)
    return out


def _institution(entry: dict[str, Any]) -> Institution:
    organization = entry.get("organization") or {}
    address = organization.get("address") or {}
    identifier = (organization.get("disambiguated-organization") or {}).get(
        "disambiguated-organization-identifier"
    )
    source_id = as_text(identifier)
    ror = source_id if source_id.startswith("https://ror.org/") else ""
    return Institution.build(
        name=as_text(organization.get("name")),
        ror_id=ror,
        country_code=as_text(address.get("country")).upper(),
        city=as_text(address.get("city")),
    )


def _record_url(orcid: str) -> str:
    return f"https://orcid.org/{orcid}"


def parse_educations(payload: dict[str, Any], orcid: str) -> list[Education]:
    entries: list[Education] = []
    for entry in _summaries(payload, "education-summary"):
        institution = _institution(entry)
        if not institution.name:
            continue
        entries.append(
            Education(
                inst_id=institution.inst_id,
                institution=institution.name,
                degree=as_text(entry.get("role-title")),
                field=as_text(entry.get("department-name")),
                year_from=_year(entry.get("start-date")),
                year_to=_year(entry.get("end-date")),
                source=SOURCE,
                source_url=_record_url(orcid),
            )
        )
    return entries


def parse_employments(payload: dict[str, Any], orcid: str) -> list[Affiliation]:
    entries: list[Affiliation] = []
    for entry in _summaries(payload, "employment-summary"):
        institution = _institution(entry)
        if not institution.name:
            continue
        end = _year(entry.get("end-date"))
        entries.append(
            Affiliation(
                inst_id=institution.inst_id,
                institution=institution.name,
                country_code=institution.country_code,
                department=as_text(entry.get("department-name")),
                role=as_text(entry.get("role-title")),
                year_from=_year(entry.get("start-date")),
                year_to=end,
                # ORCID marks an ongoing post by leaving the end date empty.
                is_current=end is None,
                source=SOURCE,
                source_url=_record_url(orcid),
            )
        )
    return entries


def institutions_from(payload: dict[str, Any], key: str) -> list[Institution]:
    """Institutions referenced by an education or employment payload."""
    seen: dict[str, Institution] = {}
    for entry in _summaries(payload, key):
        institution = _institution(entry)
        if institution.name:
            seen.setdefault(institution.inst_id, institution)
    return list(seen.values())


@dataclass
class Contact:
    """What a public ORCID record says about how to reach someone.

    ``urls`` are the researcher's own "researcher-urls" entries — pages they
    chose to publish, which is what makes fetching one defensible where a
    general web crawl would not be.
    """

    emails: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)


def parse_contact(email_payload: dict[str, Any], url_payload: dict[str, Any]) -> Contact:
    """Public addresses and self-published URLs, ignoring everything else.

    ORCID defaults an address to private and reports its visibility alongside.
    Anything not explicitly ``PUBLIC`` is not ours to use, however visible the
    API happens to make it.
    """
    emails = [
        as_text(entry.get("email"))
        for entry in (email_payload or {}).get("email") or []
        if as_text(entry.get("visibility")).upper() == "PUBLIC" and as_text(entry.get("email"))
    ]
    urls = []
    for entry in (url_payload or {}).get("researcher-url") or []:
        url = as_text((entry.get("url") or {}).get("value"))
        if url.startswith(("http://", "https://")):
            urls.append(url)
    return Contact(emails=list(dict.fromkeys(emails)), urls=list(dict.fromkeys(urls)))


class Orcid(AuthorSource):
    request_delay = 0.15

    @property
    def name(self) -> str:
        return SOURCE

    def _fetch(self, orcid: str, section: str, timeout: int) -> dict[str, Any]:
        return get_json(f"{BASE_URL}/{orcid}/{section}", SOURCE, timeout=timeout)

    def get_author(self, author_id: str, *, timeout: int = 30) -> Person | None:
        """Build a person from the public record's career sections.

        Returns ``None`` for an unknown ORCID; an empty career history is a valid
        answer, not an error — most records simply are not filled in.
        """
        orcid = normalize_orcid(author_id)
        if not orcid:
            return None
        try:
            educations = self._fetch(orcid, "educations", timeout)
            employments = self._fetch(orcid, "employments", timeout)
        except SourceError as error:
            if error.details.get("status") in (404, 409):
                return None
            raise

        person = Person(
            person_id=stable_id("person", orcid),
            display_name="",
            orcid=orcid,
            confidence=0.99,
            resolution_method="orcid",
        )
        person.education = parse_educations(educations, orcid)
        person.affiliations = parse_employments(employments, orcid)
        return person

    def get_contact(self, author_id: str, *, timeout: int = 30) -> Contact:
        """Public email addresses and self-published URLs for one researcher.

        An empty result is the common case and not an error — most records keep
        addresses private, which is exactly why nothing here is ever inferred.
        """
        orcid = normalize_orcid(author_id)
        if not orcid:
            return Contact()
        try:
            emails = self._fetch(orcid, "email", timeout)
            urls = self._fetch(orcid, "researcher-urls", timeout)
        except SourceError as error:
            if error.details.get("status") in (404, 409):
                return Contact()
            raise
        return parse_contact(emails, urls)

    def find_author_by_orcid(self, orcid: str, *, timeout: int = 30) -> Person | None:
        return self.get_author(orcid, timeout=timeout)
