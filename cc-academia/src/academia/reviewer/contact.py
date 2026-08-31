"""Finding a reviewer's address in the literature they published.

This is where an editor looks by hand: the corresponding-author footnote of the
candidate's own papers. It is the highest-confidence source in the precedence
table and, until now, the only unwired one.

The approach is shaped by measurement rather than by what ought to work. On a
live sample of stored papers:

* the open-access **landing page** returned an address in 7 of 12 fetches,
  because it renders the footnote as HTML;
* 66% had an open-access PDF URL. A publisher's own copy is often refused —
  ``403`` from MDPI, ``502`` from IEEE — but a repository copy (OSTI, a
  university's own archive, arXiv) serves fine, and for a great many papers the
  footnote was printed nowhere else;
* repository *metadata* pages (PubMed, figshare, DOAJ) yielded 0 of 9 — they
  hold abstracts, not the author block.

So this reads the landing page first and falls back to the PDF, parsing only its
front page for the footnote. It does not search the open web for a person.

What it cannot reach is a paper that is paywalled with no open copy at all: the
store then holds no URL to try, and the honest answer is ``not_found`` rather
than a pattern-generated address.

The safety property is unchanged and is the whole point: an address is only ever
attributed to a candidate when their own name matches its local part, or when
the structured record says they are the corresponding author of that exact
paper. A footnote address belongs to whoever corresponded, not to every author
on the paper, and inviting the wrong person is worse than inviting nobody.
"""

from __future__ import annotations

import re
import sqlite3
import urllib.parse
from pathlib import Path
from tempfile import TemporaryDirectory

from academia.core import log
from academia.core.models import Person
from academia.reviewer.enrich import (
    EMAIL_CONFIDENCE,
    EmailFinding,
    extract_emails,
    match_email_to_person,
)
from academia.reviewer.lookups import (
    LookupAttempt,
    annotate_lookup_status,
    lookup_worklist,
    read_homepage_file,
    read_lookup_attempts,
    read_lookups,
)

__all__ = (
    "BrowserGetter",
    "LookupAttempt",
    "annotate_lookup_status",
    "email_from_publications",
    "extract_page_emails",
    "looks_like_pdf",
    "lookup_worklist",
    "pdf_text",
    "read_homepage_file",
    "read_lookup_attempts",
    "read_lookups",
)


class BrowserGetter:
    """Read scholarly HTML/PDF through the shared literature-review browser."""

    def __init__(self, page) -> None:
        from academia.litreview.acquire.transport import BrowserTransport

        self._page = page
        self._transport = BrowserTransport(page)

    def __call__(self, url: str):
        from academia.litreview.acquire.types import Source

        with TemporaryDirectory(prefix="rev-disc-browser-") as temporary:
            target = Path(temporary) / "paper.pdf"
            found = self._transport.fetch(Source(url=url), target)
            if found and target.is_file():
                return target.read_bytes(), "application/pdf", found
        return self._page.content(), "text/html", self._page.url or url

#: How many of a candidate's papers to try. Each is a network fetch, and a
#: candidate whose first few papers carry no address rarely has one on the tenth.
MAX_PAPERS_PER_CANDIDATE = 4

SOURCE = "published_corresponding"
AUTHOR_SOURCE = "published_author"

#: Domains that belong to a publisher rather than to a researcher. A landing
#: page renders the journal's own contacts beside the author's, and
#: "journalpermissions@springernature.com" is on a great many of them.
_PUBLISHER_DOMAINS = (
    "springernature.com",
    "springer.com",
    "elsevier.com",
    "wiley.com",
    "onlinelibrary.wiley.com",
    "mdpi.com",
    "ieee.org",
    "tandf.co.uk",
    "taylorandfrancis.com",
    "sagepub.com",
    "frontiersin.org",
    "hindawi.com",
    "nature.com",
    "acs.org",
    "rsc.org",
    "iop.org",
    "copyright.com",
    "cambridge.org",
    "oup.com",
)

#: Local parts that are a role rather than a person, seen on publisher pages.
_PUBLISHER_LOCALS = (
    "permissions",
    "journalpermissions",
    "reprints",
    "editorial",
    "editor",
    "onlinelibrary",
    "customerservice",
    "subscriptions",
)

_MAILTO = re.compile(r"mailto:([^\"'>?\s]+)", re.IGNORECASE)


def is_publisher_address(email: str) -> bool:
    """Whether an address belongs to the journal rather than to a researcher."""
    lowered = (email or "").lower()
    local, _, domain = lowered.partition("@")
    if any(domain == d or domain.endswith("." + d) for d in _PUBLISHER_DOMAINS):
        return True
    return any(local.startswith(marker) for marker in _PUBLISHER_LOCALS)


#: Compatibility argument; the fast path now scans the whole paper.
PDF_FRONT_PAGES = 1

#: A PDF whose bytes start with anything else is a publisher's error page.
PDF_MAGIC = b"%PDF"


def looks_like_pdf(body: bytes, content_type: str = "", url: str = "") -> bool:
    if body[:4] == PDF_MAGIC:
        return True
    if "application/pdf" in (content_type or "").lower():
        return True
    return (url or "").lower().split("?")[0].endswith(".pdf")


def pdf_text(body: bytes, *, front_pages: int = PDF_FRONT_PAGES) -> str:
    """Extract full-paper text through ``paper_pdf_ingest`` fast mode."""
    del front_pages  # retained for source-compatible callers and policy files
    try:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        from paper_pdf_ingest import convert

        with TemporaryDirectory(prefix="rev-disc-pdf-") as temporary:
            root = Path(temporary)
            pdf = root / "paper.pdf"
            pdf.write_bytes(body)
            text, _tool = convert(pdf, root / "output", mode="fast")
            return text
    except ImportError:  # pragma: no cover - depends on optional extra
        log.detail("a PDF was fetched but the 'pdf' extra is not installed")
    except Exception as error:  # a malformed or encrypted PDF is not an outage
        log.detail(f"paper_pdf_ingest could not read PDF: {error}")
    return ""


def extract_page_emails(html: str) -> list[str]:
    """Addresses on a landing page, publisher boilerplate removed.

    ``mailto:`` links are read as well as plain text: several publishers render
    the author's address only as a link and never as visible text.
    """
    found = extract_emails(html)
    found += [urllib.parse.unquote(m).lower() for m in _MAILTO.findall(html or "")]
    ordered = list(dict.fromkeys(found))
    return [e for e in ordered if not is_publisher_address(e)]


def _candidate_papers(conn: sqlite3.Connection, person_id: str) -> list[sqlite3.Row]:
    """The candidate's papers that have a landing page, best bets first.

    Papers where they are recorded as the corresponding author come first: that
    is where their address is, and each fetch costs a second.
    """
    return list(
        conn.execute(
            """
            SELECT p.paper_id, p.landing_page_url, p.pdf_url, a.is_corresponding,
                   (SELECT count(*) FROM authorships peers
                    WHERE peers.paper_id = p.paper_id AND peers.is_corresponding = 1)
                   AS corresponding_count
            FROM authorships a
            JOIN papers p ON p.paper_id = a.paper_id
            WHERE a.person_id = ?
              AND (
                    (p.landing_page_url IS NOT NULL AND p.landing_page_url <> '')
                 OR (p.pdf_url IS NOT NULL AND p.pdf_url <> '')
              )
            ORDER BY a.is_corresponding DESC, p.year DESC
            """,
            (person_id,),
        )
    )


def _given_name_id_match(
    conn: sqlite3.Connection,
    paper_id: str,
    addresses: list[str],
    person: Person,
) -> str:
    """Match an institutional student/staff ID carrying a unique given name."""
    parts = re.findall(r"[^\W\d_]+", person.display_name.lower())
    if not parts or len(parts[0]) < 5:
        return ""
    given = parts[0]
    author_givens = [
        (re.findall(r"[^\W\d_]+", row[0].lower()) or [""])[0]
        for row in conn.execute(
            """SELECT pe.display_name FROM authorships a
               JOIN persons pe ON pe.person_id = a.person_id
               WHERE a.paper_id = ?""",
            (paper_id,),
        )
    ]
    if author_givens.count(given) != 1:
        return ""
    pattern = re.compile(rf"^{re.escape(given)}[._-]?\d+$")
    matches = [email for email in addresses if pattern.fullmatch(email.split("@", 1)[0])]
    return matches[0] if len(matches) == 1 else ""


def _within_one_edit(left: str, right: str) -> bool:
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) > len(right):
        left, right = right, left
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right, strict=True)) <= 1
    for index in range(len(right)):
        if left[:index] == right[:index] and left[index:] == right[index + 1 :]:
            return True
    return False


def _unique_full_name_typo_match(
    conn: sqlite3.Connection,
    paper_id: str,
    addresses: list[str],
    person: Person,
) -> str:
    """Accept one obvious full-name typo only when unique among paper authors."""
    rows = conn.execute(
        """SELECT pe.person_id, pe.display_name FROM authorships a
           JOIN persons pe ON pe.person_id = a.person_id
           WHERE a.paper_id = ?""",
        (paper_id,),
    ).fetchall()
    forms: dict[str, set[str]] = {}
    for row in rows:
        parts = re.findall(r"[^\W\d_]+", row["display_name"].lower())
        if len(parts) >= 2:
            forms[row["person_id"]] = {parts[0] + parts[-1], parts[-1] + parts[0]}
    for email in addresses:
        local = email.split("@", 1)[0]
        if len(local) < 6 or not local.isalpha():
            continue
        matched = [pid for pid, names in forms.items() if any(_within_one_edit(local, name) for name in names)]
        if matched == [person.person_id]:
            return email
    return ""


def hydrate_open_access_pdfs(
    conn: sqlite3.Connection,
    person_ids: list[str],
    *,
    resolver=None,
) -> int:
    """Batch-resolve OA PDF URLs for candidate papers that only carry a DOI."""
    if not person_ids:
        return 0
    placeholders = ",".join("?" for _ in person_ids)
    rows = conn.execute(
        f"""
        SELECT DISTINCT lower(p.doi) AS doi
        FROM papers p
        JOIN authorships a ON a.paper_id = p.paper_id
        WHERE a.person_id IN ({placeholders})
          AND p.doi <> ''
        """,
        person_ids,
    ).fetchall()
    dois = [row["doi"] for row in rows]
    if not dois:
        return 0
    if resolver is None:
        from academia.sources.openalex import resolve_open_access_pdfs as resolve_openalex
        from academia.sources.semantic_scholar import resolve_open_access_pdfs as resolve_s2

        def resolver(wanted):
            # OpenAlex exposes every known location, so it can select an
            # institutional repository instead of an IEEE URL that answers
            # automated PDF requests with 403. S2 fills what remains.
            try:
                found = resolve_openalex(wanted)
            except Exception as error:
                log.detail(f"OpenAlex OA resolution skipped: {error}")
                found = {}
            try:
                alternatives = resolve_s2(wanted)
            except Exception as error:
                log.detail(f"Semantic Scholar OA resolution skipped: {error}")
                alternatives = {}
            # S2 often exposes a repository copy when OpenAlex's first URL is a
            # publisher endpoint. Prefer that independently indexed copy; the
            # same DOI still proves it is the same paper.
            for doi, url in alternatives.items():
                current = found.get(doi, "")
                if not current or "repository" in url or "arxiv.org" in url:
                    found[doi] = url
            return found
    resolved = resolver(dois)
    changed = 0
    for doi, url in resolved.items():
        cursor = conn.execute(
            "UPDATE papers SET pdf_url = ? WHERE lower(doi) = ? AND coalesce(pdf_url, '') <> ?",
            (url, doi.lower(), url),
        )
        changed += cursor.rowcount
    return changed


def hydrate_recent_publications(
    conn: sqlite3.Connection,
    people: list[Person],
    *,
    year_from: int,
    limit: int = 10,
    loader=None,
) -> int:
    """Add recent works for strictly resolved authors before contact extraction."""
    from academia.store import repository as store_repo

    unresolved = [
        person
        for person in people
        if person.openalex_id and not store_repo.emails_of(conn, person.person_id)
    ]
    added = 0
    if loader is None:
        from academia.sources.openalex import recent_corresponding_works, recent_works_for_author

        loader = recent_works_for_author
        # A person's current activity and their contact evidence have different
        # clocks. Recent works below prove activity; older papers are still
        # useful when OpenAlex explicitly marks this person as corresponding.
        for paper in recent_corresponding_works(
            [person.openalex_id for person in unresolved]
        ):
            store_repo.ingest_paper(conn, paper)
            added += 1
    for person in unresolved:
        try:
            papers = loader(person.openalex_id, year_from=year_from, limit=limit)
        except Exception as error:
            log.detail(f"recent works skipped for {person.display_name}: {error}")
            continue
        for paper in papers:
            store_repo.ingest_paper(conn, paper)
            added += 1
    return added


def email_from_publications(
    conn: sqlite3.Connection,
    person: Person,
    *,
    fetcher,
    seen_pages: dict[str, list[str]] | None = None,
    max_papers: int = MAX_PAPERS_PER_CANDIDATE,
    confidence: float = EMAIL_CONFIDENCE[SOURCE],
    author_confidence: float = EMAIL_CONFIDENCE[AUTHOR_SOURCE],
) -> EmailFinding:
    """Look for the candidate's address in the front matter of their own papers.

    ``seen_pages`` memoises page text across candidates within one run. Two
    co-authors on the same paper are common in a candidate pool built from a
    single field, and the page should be fetched once.
    """
    if fetcher is None:
        return EmailFinding()

    cache = seen_pages if seen_pages is not None else {}
    for row in _candidate_papers(conn, person.person_id)[:max_papers]:
        # The landing page first: it is HTML, it is cheap, and a publisher that
        # blocks the PDF often renders the same footnote as text. The PDF is the
        # fallback, because for most papers that is the only place the address
        # was ever printed.
        for url in (row["landing_page_url"], row["pdf_url"]):
            if not url:
                continue
            if url in cache:
                addresses = cache[url]
            else:
                addresses = extract_page_emails(fetcher(url))
                cache[url] = addresses
            if not addresses:
                continue

            # A paper can list every co-author's address. A surname-only match
            # is not attributable there; structured correspondence below is.
            match = match_email_to_person(addresses, person, allow_weak=False)
            source = SOURCE if row["is_corresponding"] else AUTHOR_SOURCE
            if not match and not row["is_corresponding"]:
                match = _given_name_id_match(conn, row["paper_id"], addresses, person)
            if not match and not row["is_corresponding"]:
                match = _unique_full_name_typo_match(
                    conn, row["paper_id"], addresses, person
                )
            # The scholarly record sometimes marks the candidate as the
            # corresponding author while the address local part is an opaque
            # staff number. A sole non-publisher address on that exact paper is
            # then structured attribution, not a name-pattern guess.
            if (
                not match
                and row["is_corresponding"]
                and row["corresponding_count"] == 1
                and len(addresses) == 1
            ):
                match = addresses[0]
            if not match:
                continue

            return EmailFinding(
                email=match,
                source=source,
                source_url=url,
                confidence=confidence if source == SOURCE else author_confidence,
            )

    return EmailFinding()
