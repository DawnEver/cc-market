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

import html
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
    "published_author",
    "institutional_profile",
    "lab_homepage",
    "orcid_public",
)

EMAIL_CONFIDENCE = {
    "published_corresponding": 0.95,
    "published_author": 0.85,
    "institutional_profile": 0.9,
    "lab_homepage": 0.75,
    "orcid_public": 0.7,
}

NOT_FOUND = "not_found"

#: Weakest first. An address on the researcher's own institutional profile is
#: the one they maintain; the ORCID field is frequently years out of date.
EMAIL_PRECEDENCE = (
    "orcid_public",
    "lab_homepage",
    "published_author",
    "institutional_profile",
    "published_corresponding",
)

_ORCID_RECORD_URL = "https://orcid.org/{orcid}"
_ORCID_URL_PATTERN = re.compile(r"^https?://(?:www\.)?orcid\.org/(\d{4}-\d{4}-\d{4}-[\dX]{4})/?$", re.I)

_EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_GROUPED_EMAIL_PATTERN = re.compile(
    r"\{([^{}]+)\}\s*@\s*([A-Za-z0-9.-]+\.[A-Za-z]{2,})"
)
_EMAIL_LOCAL_PATTERN = re.compile(r"^[A-Za-z0-9._%+-]+$")
_CLOUDFLARE_EMAIL = re.compile(r"data-cfemail=[\"']([0-9a-f]{4,})[\"']", re.IGNORECASE)

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
    raw = text or ""
    cloudflare = []
    for encoded in _CLOUDFLARE_EMAIL.findall(raw):
        try:
            key = int(encoded[:2], 16)
            cloudflare.append(
                "".join(chr(int(encoded[index : index + 2], 16) ^ key) for index in range(2, len(encoded), 2))
            )
        except ValueError:
            continue
    source = html.unescape(raw).replace("＠", "@").replace("．", ".")
    # Institutional CMSs sometimes wrap each visual fragment in its own span
    # or insert an HTML comment inside the address. The rendered text is still
    # public, so scan that representation as well as the source markup.
    rendered = re.sub(r"<[^>]*>", "", source)
    source = re.sub(r"\s*[\[(]\s*at\s*[\])]\s*", "@", source, flags=re.IGNORECASE)
    source = re.sub(r"\s*[\[(]\s*dot\s*[\])]\s*", ".", source, flags=re.IGNORECASE)
    source = re.sub(r"(?<=[A-Za-z0-9._%+-])\s*@\s*(?=[A-Za-z0-9])", "@", source)
    source = re.sub(r"(?<=[A-Za-z0-9])\s*\.\s*(?=[A-Za-z]{2,}\b)", ".", source)
    matches = [*_EMAIL_PATTERN.findall(source), *_EMAIL_PATTERN.findall(rendered), *cloudflare]
    for local_parts, domain in _GROUPED_EMAIL_PATTERN.findall(source):
        matches.extend(
            f"{local.strip()}@{domain}"
            for local in re.split(r"[,;]", local_parts)
            if _EMAIL_LOCAL_PATTERN.fullmatch(local.strip())
        )
    found = []
    for match in matches:
        lowered = match.lower()
        if lowered.startswith(_ROLE_PREFIXES):
            continue
        if lowered.endswith((".png", ".jpg", ".gif")):
            continue
        found.append(lowered)
    return list(dict.fromkeys(found))


def _name_parts(name: str) -> list[str]:
    """Unicode letter-only name parts, without citation punctuation."""
    return [part.lower() for part in re.findall(r"[^\W\d_]+", name or "") if len(part) > 1]


def _name_tokens(person: Person) -> list[str]:
    tokens = [
        part
        for name in [person.display_name, *person.names]
        for part in _name_parts(name)
    ]
    return list(dict.fromkeys(tokens))


#: An initials-only local part is at most this long. "gww" and "ys" are the
#: ordinary forms; past four characters a local part is a word, not initials.
MAX_INITIALS_LOCAL = 4


def _initials_strength(local: str, person: Person) -> int:
    """Whether a local part is this person's initials and nothing else.

    ``gww`` is Geng Wei Wei and ``ys`` is Yilmaz Sozer: the address carries the
    name, but not as a substring, so the token test above cannot see it. A
    Chinese given name is written as one token ("Weiwei") while its address
    spells out both syllables, which is why this compares *sets* of letters
    rather than a fixed initial order.

    It is deliberately unforgiving. Every one of the person's initials must
    appear and no other letter may, so "gg" is not Weiwei Geng and neither is
    "gwx". Even then the result is only weak: two colleagues in one department
    share initials as readily as they share a surname, so the caller's
    sole-match rule still decides whether the address is used.
    """
    if not (2 <= len(local) <= MAX_INITIALS_LOCAL) or not local.isalpha():
        return 0
    for name in [person.display_name, *person.names]:
        parts = _name_parts(name)
        initials = {part[0] for part in parts}
        if len(initials) > 1 and set(local) == initials:
            return 1
    return 0


def match_strength(email: str, person: Person) -> int:
    """How confidently an address belongs to this person: 0 none, 1 weak, 2 strong.

    Strong means the local part carries more than a surname — either two name
    parts ("guohai.liu"), or an initial followed by the surname ("ghliu"), which
    is the ordinary academic form. Weak means a bare surname, which on a
    department directory is shared by everyone in a large family of namesakes,
    or a local part that is purely the person's initials ("gww", "ys"), which
    collides just as easily.
    """
    local = (email or "").split("@", 1)[0].lower()
    tokens = _name_tokens(person)
    if not tokens or not local:
        return 0
    hits = [token for token in tokens if token in local]
    if not hits:
        return _initials_strength(local, person)
    if len(hits) >= 2:
        return 2
    hit = hits[0]
    position = local.index(hit)
    prefix = local[:position]
    others = [t for t in tokens if t != hit]
    display_parts = _name_parts(person.display_name)
    surname = display_parts[-1] if display_parts else ""
    if hit == surname and any(other[0] in prefix for other in others):
        return 2
    # A weak match means surname only, not any single name fragment. Given-name
    # fragments can occur accidentally inside another person's local part
    # (e.g. ``hua`` in ``rundhuang``).
    return 1 if hit == surname else 0


def match_email_to_person(
    emails: list[str], person: Person, *, allow_weak: bool = True
) -> str:
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
    if not allow_weak:
        return ""
    if len(weak) == 1:
        return weak[0]
    if weak:
        log.detail(
            f"{person.display_name}: {len(weak)} addresses match the surname alone; "
            "none attributed"
        )
    return ""


def match_email_in_text(text: str, person: Person, *, radius: int = 240) -> str:
    """Attribute an address printed beside the author's full name.

    Conference headers often use opaque usernames (``mlj`` or an employee ID),
    so the local part cannot identify the author.  Proximity can, but only when
    exactly one address occurs close to an exact full-name occurrence.
    """
    emails = extract_emails(text)
    direct = match_email_to_person(emails, person)
    if direct:
        return direct
    lowered = text.casefold()
    names = [person.display_name, *person.names]
    nearby: list[str] = []
    for name in names:
        clean = " ".join(name.casefold().split())
        if len(clean.split()) < 2:
            continue
        start = 0
        while (position := lowered.find(clean, start)) >= 0:
            window = lowered[max(0, position - radius) : position + len(clean) + radius]
            nearby.extend(email for email in emails if email.casefold() in window)
            start = position + len(clean)
    unique = list(dict.fromkeys(nearby))
    return unique[0] if len(unique) == 1 else ""


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
MAX_PAGE_BYTES = 1_000_000

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
        pdf_front_pages: int = 1,
        fallback_getter=None,
    ) -> None:
        self._getter = getter or http.get_body_resolved
        self._delay = delay
        self._max_bytes = max_bytes
        self._failure_budget = failure_budget
        self._timeout = timeout
        self._pdf_front_pages = pdf_front_pages
        self._fallback_getter = fallback_getter
        self._failures: dict[str, int] = {}
        self._last_request = 0.0

    def _host(self, url: str) -> str:
        return urllib.parse.urlparse(url).netloc.lower()

    def _as_text(self, result, url: str) -> tuple[str, str]:
        return _page_fetcher_as_text(result, url, pdf_front_pages=self._pdf_front_pages)

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
            if self._fallback_getter is not None:
                try:
                    result = self._fallback_getter(url)
                except Exception:
                    pass
                else:
                    text, final_url = self._as_text(result, url)
                    return (text or "")[: self._max_bytes]
            # A request that never reached a publisher cannot be held against
            # one, and holding it against the redirector every landing page
            # shares would disable the rest of the run after two dead links.
            if host not in REDIRECTORS:
                self._failures[host] = self._failures.get(host, 0) + 1
            log.detail(f"could not read {url}: {error}")
            return ""

        text, final_url = self._as_text(result, url)
        final_host = self._host(final_url)
        if final_host and final_host not in REDIRECTORS:
            self._failures.setdefault(final_host, 0)
        return (text or "")[: self._max_bytes]


def _page_fetcher_as_text(result, url: str, *, pdf_front_pages: int = 1) -> tuple[str, str]:
    """Normalise a getter's return value to ``(text, final_url)``.

    Bytes are the real fetch: an address printed only in a paper's PDF is
    unreachable if the body was decoded as UTF-8 on the way in. A test may still
    inject a plain string, and a two-tuple of text is what the older getter
    returned, so both keep working.
    """
    from academia.reviewer.contact import looks_like_pdf, pdf_text

    if isinstance(result, tuple) and len(result) == 3:
        body, content_type, final = result
        if isinstance(body, bytes):
            if looks_like_pdf(body, content_type, final):
                return pdf_text(body, front_pages=pdf_front_pages), final
            return body.decode("utf-8", errors="replace"), final
        return body or "", final
    if isinstance(result, tuple):
        text, final = result
        return text or "", final
    return result or "", url


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
    max_papers_per_candidate: int = 4,
    email_confidence: dict[str, float] | None = None,
    email_precedence: tuple[str, ...] | None = None,
    orcid: Orcid | None = None,
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
    contact = contact or Contact()
    # A verified lookup may establish the ORCID before identity enrichment did.
    # Read its public contact endpoint instead of scraping the JavaScript page.
    for url in extra_urls or []:
        match = _ORCID_URL_PATTERN.match(url.strip())
        if not match:
            continue
        verified = (orcid or Orcid()).get_contact(match.group(1))
        contact = Contact(
            emails=list(dict.fromkeys([*contact.emails, *verified.emails])),
            urls=list(dict.fromkeys([*contact.urls, *verified.urls])),
        )
    confidence = email_confidence or EMAIL_CONFIDENCE
    precedence = email_precedence or EMAIL_PRECEDENCE
    source_rank = {source: rank for rank, source in enumerate(precedence)}
    candidates: list[EmailFinding] = []

    # What is already stored competes, it does not win by default. Handing back
    # a better URL is the documented way to correct an address, and returning
    # here made that impossible: the correction was fetched and matched, and
    # then thrown away because the answer had already been given.
    for row in repo.emails_of(conn, person.person_id):
        if row["source"] in confidence:
            candidates.append(
                EmailFinding(
                    email=row["email"],
                    source=row["source"],
                    source_url=row["source_url"] or "",
                    confidence=row["confidence"],
                )
            )

    urls = [*(extra_urls or []), *contact.urls]

    # Looking again is worth minutes of fetching when it can change the answer,
    # and nothing when it cannot. It can when the editor handed back a URL, or
    # when there is no address yet; with an address already stored and no new
    # page to read, the crawl would only rediscover what is above.
    if candidates and not urls:
        return max(candidates, key=lambda finding: source_rank.get(finding.source, -1))

    for address in contact.emails:
        candidates.append(
            EmailFinding(
                email=address,
                source="orcid_public",
                source_url=_ORCID_RECORD_URL.format(orcid=person.orcid) if person.orcid else "",
                confidence=confidence["orcid_public"],
            )
        )

    # Explicit profile/lab URLs are cheap and intentional. Try them before the
    # publication fallback so a batch of verified pages does not also trigger
    # hundreds of publisher and PDF requests.
    if fetcher is not None:
        for url in urls:
            text = fetcher(url)
            if not text:
                continue
            match = match_email_in_text(text, person)
            if not match:
                continue
            source = email_source_for(url, match)
            candidates.append(
                EmailFinding(
                    email=match,
                    source=source,
                    source_url=url,
                    confidence=confidence[source],
                )
            )

    # Publication crawling is the expensive fallback. Once an address is
    # stored, only explicitly supplied pages can improve/correct it; re-reading
    # up to N papers for that person adds minutes to a batch lookup without
    # changing the evidence the editor just supplied.
    if fetcher is not None and not candidates:
        from academia.reviewer.contact import email_from_publications

        published = email_from_publications(
            conn,
            person,
            fetcher=fetcher,
            seen_pages=seen_pages,
            max_papers=max_papers_per_candidate,
            confidence=confidence["published_corresponding"],
            author_confidence=confidence["published_author"],
        )
        if published.found:
            candidates.append(published)

    if not candidates:
        return EmailFinding()

    best = max(candidates, key=lambda finding: source_rank.get(finding.source, -1))

    # Every address that was actually observed is kept, not only the one that
    # won on precedence. Someone who has moved institution has a footnote
    # address and a current staff-page address, both real, and which of them
    # reaches them is a judgement the editor makes at the point of writing.
    for finding in candidates:
        repo.record_email(
            conn,
            person.person_id,
            finding.email,
            source=finding.source,
            source_url=finding.source_url,
            confidence=finding.confidence,
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
