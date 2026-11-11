"""Read a saved ScholarOne "Assign Reviewers" page.

The page carries two things this pipeline cannot derive itself:

* the **Reviewer List** — who the editorial office has already invited on this
  manuscript, and what each of them answered;
* the **Web of Science Reviewer Locator** — candidates Clarivate proposes from
  five years of publications, with review counts, workload and the works that
  qualified them.

Parsing is pure: text in, dataclasses out, nothing stored and nothing fetched.
The page is untrusted input — it is read as text, never executed, and every
value is unescaped and stripped before it is kept. A saved page also holds the
manuscript's title and authors; this module does not read them, so they cannot
leak into the store through it.

The page layout is ScholarOne's, not a published format, so the patterns below
are anchored on the labels a reader sees ("Verified Reviews in Web of
Science:", "Due Date:") rather than on table positions, and a page without the
sections is refused rather than read as empty.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import datetime

from academia.core.text import normalize_orcid


class NotAnAssignPage(ValueError):
    """The text is not a ScholarOne Assign Reviewers page."""


@dataclass(frozen=True)
class Work:
    """One of the Locator's "Most Relevant Works" for a candidate."""

    title: str
    authors: str = ""
    venue: str = ""
    year: int | None = None
    doi: str = ""


@dataclass(frozen=True)
class Suggestion:
    """One Reviewer Locator candidate, as the page states it."""

    name: str
    wos_url: str = ""
    orcid: str = ""
    emails: tuple[str, ...] = ()
    #: (institution, ISO country) in the order the page lists them; the first
    #: is the one Web of Science shows first, not a verified current employer.
    affiliations: tuple[tuple[str, str], ...] = ()
    verified_reviews: int = 0
    reviews_by_journal: tuple[tuple[str, int], ...] = ()
    articles: int | None = None
    works: tuple[Work, ...] = ()
    current_assignments: int | None = None
    past_year_assignments: int | None = None
    days_since_last_review: int | None = None
    r_score: float | None = None

    @property
    def wos_id(self) -> str:
        return self.wos_url.rstrip("/").rpartition("/")[2] if self.wos_url else ""


#: Statuses that mean the reviewer said no. Everything with an agreed date, or
#: a returned review, said yes; a bare "Invited" is still open.
_DECLINED = {"declined", "un-invited", "uninvited"}


@dataclass(frozen=True)
class Invitee:
    """One row of the manuscript's Reviewer List."""

    order: int
    name: str
    status: str
    affiliation: str = ""
    orcid: str = ""
    invited: str = ""
    agreed: str = ""
    declined: str = ""
    due: str = ""
    returned: str = ""
    days_in_review: int | None = None
    decision_letter: int | None = None

    @property
    def responded(self) -> bool | None:
        """None while the invitation is open — a pending answer is not a no."""
        if self.declined or self.agreed or self.returned:
            return True
        return True if self.status.lower() in _DECLINED else None

    @property
    def accepted(self) -> bool | None:
        if self.agreed or self.returned:
            return True
        if self.declined or self.status.lower() in _DECLINED:
            return False
        return None


@dataclass
class AssignPage:
    manuscript_ref: str = ""
    submitted: str = ""
    last_updated: str = ""
    #: ScholarOne's own tally, e.g. {"invited": 4, "agreed": 2}.
    summary: dict[str, int] = field(default_factory=dict)
    invitees: list[Invitee] = field(default_factory=list)
    suggestions: list[Suggestion] = field(default_factory=list)
    #: How many candidates the Locator found; the page shows the first page only.
    locator_total: int = 0


# ------------------------------------------------------------------ helpers


_TAG = re.compile(r"<[^>]+>")
_SCRIPT = re.compile(r"<script\b.*?</script>", re.S | re.I)
_SELECT = re.compile(r"<select\b.*?</select>", re.S | re.I)
_ORCID = re.compile(r"orcid\.org/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])", re.I)
_TIP = re.compile(r"showRLTip\(event,\s*'(.*?)'\);\s*return false;", re.S)
_DATE = re.compile(r"\d{1,2}-[A-Za-z]{3}-\d{4}")


def _text(fragment: str) -> str:
    """Visible text of an HTML fragment, entities decoded, whitespace collapsed."""
    plain = _TAG.sub(" ", _SCRIPT.sub(" ", fragment))
    return " ".join(html.unescape(plain).replace("\xa0", " ").split())


def _iso(value: str) -> str:
    match = _DATE.search(value or "")
    if not match:
        return ""
    try:
        return datetime.strptime(match.group(0), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return ""


def _int(value: str) -> int | None:
    match = re.search(r"-?\d+", value or "")
    return int(match.group(0)) if match else None


def _float(value: str) -> float | None:
    match = re.search(r"-?\d+(?:\.\d+)?", value or "")
    return float(match.group(0)) if match else None


def _tooltip(encoded: str) -> str:
    """The HTML inside a ``showRLTip`` call: attribute-escaped, then JS-escaped."""
    return html.unescape(encoded).replace("\\'", "'").replace('\\"', '"')


def _spans(fragment: str) -> list[str]:
    return [
        _text(m.group(1))
        for m in re.finditer(r'<span class="pagecontents">(.*?)</span>', fragment, re.S)
    ]


# ---------------------------------------------------------------- countries

#: Web of Science country spellings, upper-cased, to ISO 3166 alpha-2. WoS
#: writes a fixed vocabulary — "PEOPLES R CHINA", "U ARAB EMIRATES", "China
#: Mainland" — so this is a lookup, not a guess. A name absent from it is not a
#: country here, which is what keeps an acronym such as a society's name from
#: being read as one.
WOS_COUNTRIES: dict[str, str] = {
    "AFGHANISTAN": "AF", "ALBANIA": "AL", "ALGERIA": "DZ", "ARGENTINA": "AR",
    "ARMENIA": "AM", "AUSTRALIA": "AU", "AUSTRIA": "AT", "AZERBAIJAN": "AZ",
    "BAHRAIN": "BH", "BANGLADESH": "BD", "BELARUS": "BY", "BELGIUM": "BE",
    "BOSNIA & HERCEG": "BA", "BOSNIA AND HERZEGOVINA": "BA", "BOTSWANA": "BW",
    "BRAZIL": "BR", "BRUNEI": "BN", "BULGARIA": "BG", "CAMEROON": "CM", "CANADA": "CA",
    "CHILE": "CL", "CHINA": "CN", "CHINA MAINLAND": "CN", "PEOPLES R CHINA": "CN",
    "COLOMBIA": "CO", "COSTA RICA": "CR", "CROATIA": "HR", "CUBA": "CU", "CYPRUS": "CY",
    "CZECH REPUBLIC": "CZ", "CZECHIA": "CZ", "DENMARK": "DK", "ECUADOR": "EC",
    "EGYPT": "EG", "ENGLAND": "GB", "ESTONIA": "EE", "ETHIOPIA": "ET", "FINLAND": "FI",
    "FRANCE": "FR", "GEORGIA": "GE", "GERMANY": "DE", "GHANA": "GH", "GREECE": "GR",
    "HONG KONG": "HK", "HUNGARY": "HU", "ICELAND": "IS", "INDIA": "IN",
    "INDONESIA": "ID", "IRAN": "IR", "IRAQ": "IQ", "IRELAND": "IE", "ISRAEL": "IL",
    "ITALY": "IT", "JAPAN": "JP", "JORDAN": "JO", "KAZAKHSTAN": "KZ", "KENYA": "KE",
    "KUWAIT": "KW", "LATVIA": "LV", "LEBANON": "LB", "LIBYA": "LY", "LITHUANIA": "LT",
    "LUXEMBOURG": "LU", "MACAU": "MO", "MALAYSIA": "MY", "MALTA": "MT", "MEXICO": "MX",
    "MOLDOVA": "MD", "MONTENEGRO": "ME", "MOROCCO": "MA", "NEPAL": "NP",
    "NETHERLANDS": "NL", "NEW ZEALAND": "NZ", "NIGERIA": "NG", "NORTH IRELAND": "GB",
    "NORTH MACEDONIA": "MK", "NORWAY": "NO", "OMAN": "OM", "PAKISTAN": "PK",
    "PALESTINE": "PS", "PERU": "PE", "PHILIPPINES": "PH", "POLAND": "PL",
    "PORTUGAL": "PT", "QATAR": "QA", "ROMANIA": "RO", "RUSSIA": "RU", "SAUDI ARABIA": "SA",
    "SCOTLAND": "GB", "SERBIA": "RS", "SINGAPORE": "SG", "SLOVAKIA": "SK",
    "SLOVENIA": "SI", "SOUTH AFRICA": "ZA", "SOUTH KOREA": "KR", "SPAIN": "ES",
    "SRI LANKA": "LK", "SUDAN": "SD", "SWEDEN": "SE", "SWITZERLAND": "CH", "SYRIA": "SY",
    "TAIWAN": "TW", "TANZANIA": "TZ", "THAILAND": "TH", "TUNISIA": "TN", "TURKEY": "TR",
    "TURKIYE": "TR", "U ARAB EMIRATES": "AE", "UNITED ARAB EMIRATES": "AE",
    "UGANDA": "UG", "UKRAINE": "UA", "UNITED KINGDOM": "GB", "URUGUAY": "UY",
    "USA": "US", "UNITED STATES": "US", "UZBEKISTAN": "UZ", "VENEZUELA": "VE",
    "VIETNAM": "VN", "WALES": "GB", "YEMEN": "YE", "ZAMBIA": "ZM", "ZIMBABWE": "ZW",
}


def country_code(name: str) -> str:
    return WOS_COUNTRIES.get(" ".join((name or "").upper().split()), "")


def split_contact_line(line: str) -> tuple[tuple[str, ...], tuple[tuple[str, str], ...]]:
    """``"a@x.org; Inst, Town, COUNTRY, Inst, COUNTRY"`` into emails and places.

    Institution names contain commas, so a place ends at the next token that is
    a known country rather than at every comma. Tokens left after the last
    country make one place with no country.
    """
    emails: list[str] = []
    rest: list[str] = []
    for part in (p.strip() for p in (line or "").split(";")):
        if re.fullmatch(r"[^\s@,]+@[^\s@,]+\.[^\s@,]+", part):
            emails.append(part.lower())
        elif part:
            rest.append(part)
    places: list[tuple[str, str]] = []
    pending: list[str] = []
    for token in (t.strip() for t in ", ".join(rest).split(",")):
        if not token:
            continue
        code = country_code(token)
        if code and pending:
            places.append((", ".join(pending), code))
            pending = []
        elif not code:
            pending.append(token)
    if pending:
        places.append((", ".join(pending), ""))
    return tuple(emails), tuple(places)


# ------------------------------------------------------------------ header


def _header(text: str, page: AssignPage) -> None:
    if match := re.search(r"<b>\s*([A-Z][A-Z0-9]*-[A-Z0-9.-]*\d)\s*</b>\s*\(", text):
        page.manuscript_ref = match.group(1)
    if match := re.search(r"Submitted:\s*([^;<]+)", text):
        page.submitted = _iso(match.group(1))
    if match := re.search(r"Last Updated:\s*([^;<]+)", text):
        page.last_updated = _iso(match.group(1))
    if match := re.search(r">([^<>]*\bactive selections\b[^<>]*)<", text):
        for part in match.group(1).split(";"):
            if found := re.match(r"\s*(\d+)\s+(.+?)\s*$", part):
                page.summary[found.group(2)] = int(found.group(1))


# ----------------------------------------------------------- reviewer list

_HISTORY = re.compile(
    r'<p class="pagecontents">\s*([^<]+?)\s*:\s*</p>\s*</td>\s*<td[^>]*>\s*'
    r'<p class="pagecontents">\s*([^<]*?)\s*</p>',
    re.S,
)


def _invitee(order: int, chunk: str) -> Invitee | None:
    cells = chunk.split('<td class="tablelightcolor"')
    if len(cells) < 5:
        return None
    name_cell, status_cell, history_cell = cells[2], cells[3], cells[4]
    names = [_text(m) for m in re.findall(r"<a\b[^>]*>(.*?)</a>", name_cell, re.S)]
    name = next((n for n in names if n and "orcid.org" not in n), "")
    if not name:
        return None
    affiliation = ""
    if match := re.search(
        r'</a>\s*<br>.*?</span>\s*<span class="pagecontents">(.*?)</span>', name_cell, re.S
    ):
        affiliation = _text(match.group(1))
    orcid = match.group(1) if (match := _ORCID.search(name_cell)) else ""
    status_html = _SELECT.sub(" ", _SCRIPT.sub(" ", status_cell))
    status = ""
    if match := re.search(r'<p class="pagecontents">\s*(.*?)\s*(?:<br>|</p>)', status_html, re.S):
        status = _text(match.group(1))
    history = {label.strip().lower(): value for label, value in _HISTORY.findall(history_cell)}
    return Invitee(
        order=order,
        name=name,
        status=status,
        affiliation=affiliation,
        orcid=normalize_orcid(orcid),
        invited=_iso(history.get("invited", "")),
        agreed=_iso(history.get("agreed", "")),
        declined=_iso(history.get("declined", "")),
        due=_iso(history.get("due date", "")),
        returned=_iso(history.get("review returned", "")),
        days_in_review=_int(history.get("time in review", "")),
        decision_letter=_int(history.get("# in decision letter", "")),
    )


def _reviewer_list(text: str) -> list[Invitee]:
    start = text.find("<b>Reviewer List</b>")
    if start < 0:
        return []
    end = text.find("tailsheaderWOSbg", start)
    region = text[start : end if end > 0 else len(text)]
    chunks = re.split(r'<input type="hidden" name="XIK_RP_ID\d+"', region)[1:]
    found = (_invitee(order, chunk) for order, chunk in enumerate(chunks, start=1))
    return [invitee for invitee in found if invitee is not None]


# ---------------------------------------------------------------- locator


def _journal_counts(tip: str) -> tuple[tuple[str, int], ...]:
    pairs = []
    for span in _spans(tip):
        journal, _, count = span.rpartition(":")
        if journal and (number := _int(count)) is not None:
            pairs.append((journal.strip(), number))
    return tuple(pairs)


def _work(tip: str) -> Work | None:
    spans = _spans(tip)
    if not spans:
        return None
    title = spans[0]
    authors = spans[1] if len(spans) > 1 else ""
    venue, year = "", None
    if len(spans) > 2 and not spans[2].startswith("DOI"):
        head, _, tail = spans[2].rpartition(",")
        if head and (number := _int(tail)) is not None and len(tail.strip()) == 4:
            venue, year = head.strip(), number
        else:
            venue = spans[2]
    doi = ""
    if match := re.search(r"doi\.org/([^'\"\s<>]+)", tip):
        doi = html.unescape(match.group(1))
    return Work(title=title, authors=authors, venue=venue, year=year, doi=doi)


def _suggestion(chunk: str) -> Suggestion | None:
    name_match = re.search(r"<b>(.*?)</b>", chunk, re.S)
    # A candidate always carries its review line; the pager below the list
    # also sits in a test123top cell with a bold word, and is not a person.
    if not name_match or "Verified Reviews in Web of Science" not in chunk:
        return None
    wos = re.search(r'href="(https?://[^"]*webofscience\.com/wos/author/record/[^"]+)"', chunk)
    orcid = _ORCID.search(chunk)
    contact = ""
    for match in re.finditer(
        r'<td colspan="2">\s*<span class="pagecontents">\s*([^<]*?)\s*</span>', chunk
    ):
        value = _text(match.group(1))
        if value and not value.startswith("Most Relevant"):
            contact = value
            break
    emails, places = split_contact_line(contact)

    reviews, by_journal = 0, ()
    if match := re.search(
        r"Verified Reviews in Web of Science:</strong>(.*?)</span>", chunk, re.S
    ):
        block = match.group(1)
        if count := re.search(r"<strong>\s*(\d+)\s*</strong>", block):
            reviews = int(count.group(1))
        if tip := _TIP.search(block):
            by_journal = _journal_counts(_tooltip(tip.group(1)))
    articles = None
    if match := re.search(
        r"Articles in Web of Science:</strong>.*?<strong>\s*(\d+)\s*</strong>", chunk, re.S
    ):
        articles = int(match.group(1))

    works: list[Work] = []
    marker = chunk.find("Most Relevant Works")
    if marker >= 0:
        for tip in _TIP.finditer(chunk, marker):
            if work := _work(_tooltip(tip.group(1))):
                works.append(work)

    stats = [
        _text(m)
        for m in re.findall(r'<td class="test123top"\s[^>]*>(.*?)</td>', chunk, re.S)
    ]
    load = stats[0] if stats else ""
    current, _, past = load.partition("/")
    return Suggestion(
        name=_text(name_match.group(1)),
        wos_url=wos.group(1) if wos else "",
        orcid=normalize_orcid(orcid.group(1)) if orcid else "",
        emails=emails,
        affiliations=places,
        verified_reviews=reviews,
        reviews_by_journal=by_journal,
        articles=articles,
        works=tuple(works),
        current_assignments=_int(current),
        past_year_assignments=_int(past),
        days_since_last_review=_int(stats[1]) if len(stats) > 1 else None,
        r_score=_float(stats[2]) if len(stats) > 2 else None,
    )


def _locator(text: str) -> tuple[list[Suggestion], int]:
    start = text.find("Potential Reviewer Details")
    if start < 0:
        return [], 0
    end = text.find('id="brn', start)
    region = text[start : end if end > 0 else len(text)]
    chunks = region.split('<td class="test123top">')[1:]
    found = [s for s in (_suggestion(chunk) for chunk in chunks) if s is not None]
    total = len(found)
    if match := re.search(r"Results\b.*?\bof\s+(\d+)", _text(region)):
        total = max(total, int(match.group(1)))
    return found, total


def parse(text: str) -> AssignPage:
    """Read the page. Raises :class:`NotAnAssignPage` when neither section is there."""
    page = AssignPage()
    _header(text, page)
    page.invitees = _reviewer_list(text)
    page.suggestions, page.locator_total = _locator(text)
    if not page.invitees and not page.suggestions and "Reviewer List" not in text:
        raise NotAnAssignPage(
            "no Reviewer List and no Reviewer Locator results on this page — save the "
            "manuscript's Assign Reviewers page from ScholarOne"
        )
    return page


# ------------------------------------------------------------------ storing


@dataclass
class ImportResult:
    #: How each Locator candidate was attached to a person, by method.
    locator: dict[str, int] = field(default_factory=dict)
    #: The same for the reviewer list.
    invitees: dict[str, int] = field(default_factory=dict)


#: An address the Locator states. Below a published corresponding address,
#: above a bare public ORCID one: Clarivate shows the address it mails, but
#: cannot say whether it is still current.
LOCATOR_SOURCE = "reviewer_locator"
LOCATOR_EMAIL_CONFIDENCE = 0.8


def _display(name: str) -> str:
    """``Last, First`` as ``First Last`` — the order the rest of the store uses."""
    surname, comma, given = name.partition(",")
    return f"{given.strip()} {surname.strip()}".strip() if comma else name.strip()


class _Resolver:
    """ORCID, then a stored address, then a name — the last only within the run.

    A name is never an identity (see AGENTS.md): it is accepted here only when
    exactly one person in *this run's* pool carries it, the pool being the
    harvested candidates plus whoever the page itself already resolved. Outside
    that pool a name creates a new low-confidence person rather than attaching
    one editor's page to another researcher with the same name.
    """

    def __init__(self, conn, pool: list[str]):
        from academia.store import repository as repo

        self.conn, self.repo = conn, repo
        self.pool = list(dict.fromkeys(pool))

    def _by_name(self, name: str) -> str | None:
        from academia.core.text import normalize_name

        key = normalize_name(name)
        hits = []
        for person_id in dict.fromkeys(self.pool):
            person = self.repo.load_person(self.conn, person_id)
            if person and key in {normalize_name(n) for n in [person.display_name, *person.names]}:
                hits.append(person_id)
        return hits[0] if len(hits) == 1 else None

    def __call__(self, name: str, orcid: str = "", emails: tuple[str, ...] = ()) -> tuple[str, str]:
        from academia.core.models import Author

        found, method = self.repo.person_by_orcid(self.conn, orcid), "orcid"
        if not found:
            method = "email"
            found = next(
                (pid for pid in (self.repo.person_by_email(self.conn, e) for e in emails) if pid),
                None,
            )
        if not found:
            found, method = self._by_name(name), "name"
        if not found:
            found = self.repo.upsert_person(self.conn, Author(name=name, idx=0, orcid=orcid))
            method = "new"
        elif orcid:
            self.conn.execute(
                "UPDATE persons SET orcid = ?, confidence = max(confidence, 0.99), "
                "resolution_method = 'orcid' WHERE person_id = ? AND coalesce(orcid, '') = ''",
                (orcid, found),
            )
        self.repo.add_name_variants(self.conn, found, [name])
        self.pool.append(found)
        return found, method


def _first_per_person(rows: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for row in rows:
        seen.setdefault(row["person_id"], row)
    return list(seen.values())


def store_page(conn, page: AssignPage, ms_id: str, *, candidate_rows: list[dict]) -> ImportResult:
    """Attach everything the page states to people in the store, for one manuscript.

    Replaces this manuscript's previous import, so importing a re-saved page
    updates statuses rather than duplicating them. Invitation outcomes go to
    ``review_history`` — the portable record ``rev-disc invite`` also writes —
    so a person invited here is known as invited on every machine.
    """
    from dataclasses import asdict

    from academia.store import repository as repo

    resolve = _Resolver(conn, [row["person_id"] for row in candidate_rows])
    result = ImportResult()

    locator_rows = []
    for position, suggestion in enumerate(page.suggestions, start=1):
        person_id, method = resolve(suggestion.name, suggestion.orcid, suggestion.emails)
        result.locator[method] = result.locator.get(method, 0) + 1
        for email in suggestion.emails:
            repo.record_email(
                conn,
                person_id,
                email,
                source=LOCATOR_SOURCE,
                source_url=suggestion.wos_url,
                confidence=LOCATOR_EMAIL_CONFIDENCE,
            )
        if suggestion.affiliations:
            institution, country = suggestion.affiliations[0]
            # Not marked current: the Locator lists every affiliation it has
            # seen, and a bibliographic current one must still win.
            repo.store_institution_for(
                conn,
                person_id,
                name=institution,
                country_code=country,
                is_current=False,
                source=LOCATOR_SOURCE,
                source_url=suggestion.wos_url,
            )
        data = asdict(suggestion)
        data["wos_id"] = suggestion.wos_id
        locator_rows.append(
            {"person_id": person_id, "position": position, "match_method": method, "data": data}
        )
    repo.replace_locator_suggestions(conn, ms_id, _first_per_person(locator_rows))

    invitee_rows = []
    for invitee in page.invitees:
        person_id, method = resolve(_display(invitee.name), invitee.orcid)
        result.invitees[method] = result.invitees.get(method, 0) + 1
        repo.record_invitation(
            conn,
            person_id,
            ms_id,
            invited_at=invitee.invited,
            responded=invitee.responded,
            accepted=invitee.accepted,
            note=f"ScholarOne: {invitee.status}" if invitee.status else "",
        )
        invitee_rows.append(
            {
                "person_id": person_id,
                "position": invitee.order,
                "match_method": method,
                "data": asdict(invitee),
            }
        )
    repo.replace_editorial_invitations(conn, ms_id, _first_per_person(invitee_rows))

    repo.set_editorial_import(
        conn,
        ms_id,
        {
            "manuscript_ref": page.manuscript_ref,
            "submitted": page.submitted,
            "last_updated": page.last_updated,
            "summary": page.summary,
            "locator_shown": len(page.suggestions),
            "locator_total": page.locator_total,
        },
    )
    return result


def merge_candidates(conn, rows: list[dict], ms_id: str) -> list[dict]:
    """The run's candidates plus every Locator person not already among them.

    A Locator person joins with no evidence: their Locator works are Clarivate's
    choice, not papers this run scored, so they are shown beside the candidate
    rather than counted by rules that read relevance. With no relevant record
    those rules abstain, as they do for any gap.
    """
    from academia.store import repository as repo

    present = {row["person_id"] for row in rows}
    added = []
    for suggestion in repo.locator_suggestions(conn, ms_id):
        if suggestion["person_id"] in present:
            continue
        person = repo.load_person(conn, suggestion["person_id"])
        if person is None:
            continue
        present.add(person.person_id)
        added.append(
            {
                "person_id": person.person_id,
                "name": person.display_name,
                "orcid": person.orcid,
                "confidence": person.confidence,
                "resolution_method": person.resolution_method,
                "evidence": [],
                "relevant_papers": [],
            }
        )
    return [*rows, *added]
