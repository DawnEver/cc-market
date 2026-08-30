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

There is no fifth rule. ``firstname.lastname@example.edu`` is never generated:
a guessed address either bounces or reaches the wrong person, and an editor
cannot tell which. When nothing is found the answer is ``not_found``.
"""

from __future__ import annotations

import re
import sqlite3
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any

from academia.core import http, log
from academia.core.errors import SourceError
from academia.core.models import Person
from academia.sources.openalex import OpenAlex
from academia.sources.orcid import Contact, Orcid
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

#: Weakest first. An address on the researcher's own institutional profile is
#: the one they maintain; the ORCID field is frequently years out of date.
EMAIL_PRECEDENCE = ("orcid_public", "lab_homepage", "institutional_profile", "published_corresponding")

_ORCID_RECORD_URL = "https://orcid.org/{orcid}"

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


def _name_tokens(person: Person) -> list[str]:
    tokens = [
        part
        for name in [person.display_name, *person.names]
        for part in name.lower().replace("-", " ").split()
        if len(part) > 2
    ]
    return list(dict.fromkeys(tokens))


def match_strength(email: str, person: Person) -> int:
    """How confidently an address belongs to this person: 0 none, 1 weak, 2 strong.

    Strong means the local part carries more than a surname — either two name
    parts ("guohai.liu"), or an initial followed by the surname ("ghliu"), which
    is the ordinary academic form. Weak means a bare surname, which on a
    department directory is shared by everyone in a large family of namesakes.
    """
    local = (email or "").split("@", 1)[0].lower()
    tokens = _name_tokens(person)
    if not tokens or not local:
        return 0
    hits = [token for token in tokens if token in local]
    if not hits:
        return 0
    if len(hits) >= 2:
        return 2
    hit = hits[0]
    position = local.index(hit)
    prefix = local[:position]
    others = [t for t in tokens if t != hit]
    if any(other[0] in prefix for other in others):
        return 2
    # A weak match means surname only, not any single name fragment. Given-name
    # fragments can occur accidentally inside another person's local part
    # (e.g. ``hua`` in ``rundhuang``).
    display_parts = person.display_name.lower().replace("-", " ").split()
    surname = display_parts[-1] if display_parts else ""
    return 1 if hit == surname else 0


def match_email_to_person(emails: list[str], person: Person) -> str:
    """Pick the address most likely to belong to this person.

    Requires the local part to carry a piece of their name. Without that check a
    departmental page yields whichever address appeared first, which is how
    invitations reach the wrong researcher.

    A *weak* match — the surname alone — is only accepted when it is the sole
    match on the page. On someone's own profile there is nobody else it could
    belong to; on a faculty directory listing three Lius, it is a coin toss, and
    a wrong address is worse than none.
    """
    scored = [(match_strength(email, person), email) for email in emails]
    strong = [email for strength, email in scored if strength == 2]
    if strong:
        return strong[0]
    weak = [email for strength, email in scored if strength == 1]
    if len(weak) == 1:
        return weak[0]
    if weak:
        log.detail(
            f"{person.display_name}: {len(weak)} addresses match the surname alone; "
            "none attributed"
        )
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
            kind=affiliation.kind,
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
    if profile.topics:
        repo.set_person_topics(conn, person.person_id, profile.topics, source="openalex")
    if profile.works_by_year:
        repo.record_output(
            conn,
            person.person_id,
            profile.works_by_year,
            source="openalex",
            source_url=f"https://openalex.org/{profile.openalex_id}" if profile.openalex_id else "",
        )
        person.works_by_year = profile.works_by_year
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
            role=employment.role,
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
    return enrich_from_orcid(conn, refreshed, source=orcid)


def contact_for(person: Person, *, source: Orcid | None = None) -> Contact:
    """Public addresses and self-published URLs, or nothing.

    A failure here is not worth aborting an enrichment pass over: contact
    details are the most optional field in the dossier.
    """
    if not person.orcid:
        return Contact()
    client = source or Orcid()
    try:
        return client.get_contact(person.orcid)
    except SourceError as error:
        log.warn(f"orcid contact lookup failed for {person.display_name}: {error}")
        return Contact()


# ----------------------------------------------------------------- email


#: Public homepages are small. Anything larger is a document dump or a listing
#: page, and reading further costs time without adding contact details.
MAX_PAGE_BYTES = 400_000

#: Consecutive failures tolerated per host before it is left alone. The design
#: circuit-breaks rather than retrying: a dead or blocking host must cost one
#: run a few seconds, not a few minutes.
HOST_FAILURE_BUDGET = 2

#: Seconds between requests. One page per researcher, so politeness costs little.
PAGE_REQUEST_DELAY = 1.0

#: Hosts that only ever redirect. Counting failures against them would let two
#: dead publishers disable every remaining lookup, since almost every
#: open-access landing page is a doi.org link.
REDIRECTORS = frozenset({"doi.org", "dx.doi.org", "www.doi.org"})


class PageFetcher:
    """Rate-limited, size-capped page reader with a per-host circuit breaker.

    Injected into email discovery rather than called from it, so the crawl
    policy stays a decision of the caller and the discovery logic stays
    testable without a network.
    """

    def __init__(
        self,
        *,
        getter=None,
        delay: float = PAGE_REQUEST_DELAY,
        max_bytes: int = MAX_PAGE_BYTES,
        failure_budget: int = HOST_FAILURE_BUDGET,
        timeout: int = 15,
    ) -> None:
        self._getter = getter or http.get_text_resolved
        self._delay = delay
        self._max_bytes = max_bytes
        self._failure_budget = failure_budget
        self._timeout = timeout
        self._failures: dict[str, int] = {}
        self._last_request = 0.0

    def _host(self, url: str) -> str:
        return urllib.parse.urlparse(url).netloc.lower()

    def __call__(self, url: str) -> str:
        """Return the page text, or an empty string. Never raises."""
        host = self._host(url)
        if host not in REDIRECTORS and self._failures.get(host, 0) >= self._failure_budget:
            log.detail(f"skipping {host}: past its failure budget for this run")
            return ""

        elapsed = time.monotonic() - self._last_request
        if self._delay and elapsed < self._delay:
            time.sleep(self._delay - elapsed)
        self._last_request = time.monotonic()

        try:
            result = self._getter(url, "homepage", timeout=self._timeout)
        except Exception as error:
            # A request that never reached a publisher cannot be held against
            # one, and holding it against the redirector every landing page
            # shares would disable the rest of the run after two dead links.
            if host not in REDIRECTORS:
                self._failures[host] = self._failures.get(host, 0) + 1
            log.detail(f"could not read {url}: {error}")
            return ""

        text, final_url = result if isinstance(result, tuple) else (result, url)
        final_host = self._host(final_url)
        if final_host and final_host not in REDIRECTORS:
            self._failures.setdefault(final_host, 0)
        return (text or "")[: self._max_bytes]


def email_source_for(url: str, email: str = "") -> str:
    """Institutional profile, or a lab page.

    A university is not always spelled out in its domain — mcmaster.ca and
    uwindsor.ca are as institutional as any .edu. When the address sits on the
    same domain as the page that published it, the page belongs to the employer.
    """
    if _looks_institutional(url):
        return "institutional_profile"
    domain = (email or "").partition("@")[2].lower()
    host = urllib.parse.urlparse(url or "").netloc.lower()
    if domain and (host == domain or host.endswith("." + domain)):
        return "institutional_profile"
    return "lab_homepage"


def discover_email(
    conn: sqlite3.Connection,
    person: Person,
    *,
    contact: Contact | None = None,
    fetcher=None,
    extra_urls: list[str] | None = None,
    seen_pages: dict[str, list[str]] | None = None,
) -> EmailFinding:
    """Find a public professional address, in the order the policy requires.

    Precedence is published corresponding address, then an institutional page,
    then a lab page, then a public ORCID address — deliberately not cheapest
    first. An address on the researcher's own institutional profile is the one
    they maintain; the ORCID field is often years stale.

    Every page read is one the researcher published themselves in their ORCID
    record, or one the editor supplied. Nothing here searches the open web for
    a person, and nothing constructs an address from a name and a domain.
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

    contact = contact or Contact()
    candidates: list[EmailFinding] = []

    # The candidate's own corresponding-author footnote outranks everything
    # else, so it is worth the fetches even when ORCID already offered one.
    if fetcher is not None:
        from academia.reviewer.contact import email_from_publications

        published = email_from_publications(
            conn, person, fetcher=fetcher, seen_pages=seen_pages
        )
        if published.found:
            candidates.append(published)

    urls = [*(extra_urls or []), *contact.urls]
    if fetcher is not None:
        for url in urls:
            text = fetcher(url)
            if not text:
                continue
            match = match_email_to_person(extract_emails(text), person)
            if not match:
                continue
            source = email_source_for(url, match)
            candidates.append(
                EmailFinding(
                    email=match,
                    source=source,
                    source_url=url,
                    confidence=EMAIL_CONFIDENCE[source],
                )
            )

    for address in contact.emails:
        candidates.append(
            EmailFinding(
                email=address,
                source="orcid_public",
                source_url=_ORCID_RECORD_URL.format(orcid=person.orcid) if person.orcid else "",
                confidence=EMAIL_CONFIDENCE["orcid_public"],
            )
        )

    if not candidates:
        return EmailFinding()

    best = max(candidates, key=lambda finding: EMAIL_PRECEDENCE.index(finding.source))
    repo.record_email(
        conn,
        person.person_id,
        best.email,
        source=best.source,
        source_url=best.source_url,
        confidence=best.confidence,
    )
    return best


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
