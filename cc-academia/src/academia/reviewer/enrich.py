"""Fill in a candidate's affiliation, career history and public contact address.

Background and email are one step rather than two on purpose. ORCID fills the
education section for roughly 30% of researchers in this field (measured on a
live sample), so an institutional homepage often has to be fetched anyway — and
that single fetch can yield both the address and the degree history, with one
shared ``source_url`` backing both claims.

Email rules, in order of trust:

1. a corresponding-author address printed in a published paper
2. an official institutional profile page
3. an official lab or group page
4. an ORCID record where the researcher chose to publish their address

There is no fifth rule. ``firstname.lastname@university.edu`` is never generated:
a guessed address either bounces or reaches the wrong person, and an editor
cannot tell which. When nothing is found the answer is ``not_found``.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Any

from academia.core import log
from academia.core.errors import SourceError
from academia.core.models import Person
from academia.sources.openalex import OpenAlex
from academia.sources.orcid import Orcid
from academia.store import repository as repo

EMAIL_SOURCES = (
    "published_corresponding",
    "institutional_profile",
    "lab_homepage",
    "orcid_public",
)

EMAIL_CONFIDENCE = {
    "published_corresponding": 0.95,
    "institutional_profile": 0.9,
    "lab_homepage": 0.75,
    "orcid_public": 0.7,
}

NOT_FOUND = "not_found"

_EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

#: Addresses that belong to a service rather than a person.
_ROLE_PREFIXES = (
    "info@",
    "contact@",
    "admin@",
    "support@",
    "webmaster@",
    "enquiries@",
    "office@",
    "noreply@",
    "no-reply@",
)


@dataclass
class EmailFinding:
    email: str = ""
    source: str = NOT_FOUND
    source_url: str = ""
    confidence: float = 0.0

    @property
    def found(self) -> bool:
        return bool(self.email)

    def as_dict(self) -> dict[str, Any]:
        return {
            "email": self.email or None,
            "source": self.source,
            "source_url": self.source_url or None,
            "confidence": self.confidence,
        }


def extract_emails(text: str) -> list[str]:
    """Pull plausible personal addresses out of a page, dropping role accounts."""
    found = []
    for match in _EMAIL_PATTERN.findall(text or ""):
        lowered = match.lower()
        if lowered.startswith(_ROLE_PREFIXES):
            continue
        if lowered.endswith((".png", ".jpg", ".gif")):
            continue
        found.append(lowered)
    return list(dict.fromkeys(found))


def match_email_to_person(emails: list[str], person: Person) -> str:
    """Pick the address most likely to belong to this person.

    Requires the local part to contain a piece of their name. Without that check
    a departmental page yields whichever address appeared first, which is how
    invitations reach the wrong researcher.
    """
    parts = {p for name in [person.display_name, *person.names] for p in name.lower().split() if len(p) > 2}
    if not parts:
        return ""
    for email in emails:
        local = email.split("@", 1)[0].lower()
        if any(part in local for part in parts):
            return email
    return ""


# ------------------------------------------------------------- background


def enrich_from_openalex(
    conn: sqlite3.Connection, person: Person, *, source: OpenAlex | None = None
) -> Person:
    """Affiliations, countries and topic profile — the fields IEEE never returns."""
    if not person.openalex_id:
        return person
    client = source or OpenAlex()
    try:
        profile = client.get_author(person.openalex_id)
    except SourceError as error:
        log.warn(f"openalex enrichment failed for {person.display_name}: {error}")
        return person
    if profile is None:
        return person

    for affiliation in profile.affiliations:
        repo.store_institution_for(
            conn,
            person.person_id,
            name=affiliation.institution,
            country_code=affiliation.country_code,
            year_from=affiliation.year_from,
            year_to=affiliation.year_to,
            is_current=affiliation.is_current,
            source="openalex",
            source_url=affiliation.source_url,
        )
    if profile.names:
        repo.add_name_variants(conn, person.person_id, profile.names)
    if profile.orcid and not person.orcid:
        conn.execute(
            "UPDATE persons SET orcid = ?, confidence = max(confidence, 0.99), "
            "resolution_method = 'orcid' WHERE person_id = ?",
            (profile.orcid, person.person_id),
        )
    person.topics = profile.topics or person.topics
    return person


def enrich_from_orcid(
    conn: sqlite3.Connection, person: Person, *, source: Orcid | None = None
) -> Person:
    """Education and employment. Absent for most records, and that is acceptable."""
    if not person.orcid:
        return person
    client = source or Orcid()
    try:
        record = client.get_author(person.orcid)
    except SourceError as error:
        log.warn(f"orcid enrichment failed for {person.display_name}: {error}")
        return person
    if record is None:
        return person

    for education in record.education:
        from academia.core.models import Institution

        institution = Institution.build(name=education.institution, country_code="")
        repo.upsert_institution(conn, institution)
        education.inst_id = institution.inst_id
        repo.record_education(conn, person.person_id, education)

    for employment in record.affiliations:
        repo.store_institution_for(
            conn,
            person.person_id,
            name=employment.institution,
            country_code=employment.country_code,
            department=employment.department,
            year_from=employment.year_from,
            year_to=employment.year_to,
            is_current=employment.is_current,
            source="orcid",
            source_url=employment.source_url,
        )
    return person


def enrich(
    conn: sqlite3.Connection,
    person: Person,
    *,
    openalex: OpenAlex | None = None,
    orcid: Orcid | None = None,
) -> Person:
    """One pass over every enrichment source for a single candidate."""
    person = enrich_from_openalex(conn, person, source=openalex)
    refreshed = repo.load_person(conn, person.person_id) or person
    refreshed.topics = person.topics
    return enrich_from_orcid(conn, refreshed, source=orcid)


# ----------------------------------------------------------------- email


def find_email(
    conn: sqlite3.Connection,
    person: Person,
    *,
    page_fetcher=None,
    homepage_urls: list[str] | None = None,
) -> EmailFinding:
    """Look for a public professional address, recording where it came from.

    ``page_fetcher`` is injected so this is testable and so a caller can decide
    the crawl policy. Without one, only addresses already in the database are
    considered — the function never invents a pattern to fill the gap.
    """
    stored = repo.emails_of(conn, person.person_id)
    if stored:
        row = stored[0]
        return EmailFinding(
            email=row["email"],
            source=row["source"],
            source_url=row["source_url"] or "",
            confidence=row["confidence"],
        )

    if page_fetcher is None or not homepage_urls:
        return EmailFinding()

    for url in homepage_urls:
        try:
            text = page_fetcher(url)
        except Exception as error:
            log.detail(f"skipped {url}: {error}")
            continue
        candidate = match_email_to_person(extract_emails(text), person)
        if not candidate:
            continue
        source = "institutional_profile" if _looks_institutional(url) else "lab_homepage"
        finding = EmailFinding(
            email=candidate,
            source=source,
            source_url=url,
            confidence=EMAIL_CONFIDENCE[source],
        )
        repo.record_email(
            conn,
            person.person_id,
            finding.email,
            source=finding.source,
            source_url=finding.source_url,
            confidence=finding.confidence,
        )
        return finding

    return EmailFinding()


def _looks_institutional(url: str) -> bool:
    lowered = (url or "").lower()
    return any(marker in lowered for marker in (".edu", ".ac.", "univ", "university"))
