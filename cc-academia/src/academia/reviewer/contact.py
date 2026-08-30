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

#: How many of a candidate's papers to try. Each is a network fetch, and a
#: candidate whose first few papers carry no address rarely has one on the tenth.
MAX_PAPERS_PER_CANDIDATE = 4

SOURCE = "published_corresponding"

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


#: The author block and corresponding-author footnote are on the first page.
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
    """The front page of a paper as text, or empty without the PDF extra."""
    try:
        import pymupdf as fitz  # from the 'pdf' extra
    except ImportError:  # pragma: no cover - depends on optional extra
        log.detail("a PDF was fetched but the 'pdf' extra is not installed")
        return ""

    try:
        with fitz.open(stream=body, filetype="pdf") as document:
            wanted = range(min(front_pages, document.page_count))
            pages = [document.load_page(index).get_text("text") for index in wanted]
            return "\n".join(pages)
    except Exception as error:  # a truncated or encrypted file is not an outage
        log.detail(f"could not read PDF: {error}")
        return ""


def extract_page_emails(html: str) -> list[str]:
    """Addresses on a landing page, publisher boilerplate removed.

    ``mailto:`` links are read as well as plain text: several publishers render
    the author's address only as a link and never as visible text.
    """
    found = extract_emails(html)
    found += [m.lower() for m in _MAILTO.findall(html or "")]
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
            SELECT p.paper_id, p.landing_page_url, p.pdf_url, a.is_corresponding
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


def email_from_publications(
    conn: sqlite3.Connection,
    person: Person,
    *,
    fetcher,
    seen_pages: dict[str, list[str]] | None = None,
    max_papers: int = MAX_PAPERS_PER_CANDIDATE,
    confidence: float = EMAIL_CONFIDENCE[SOURCE],
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

            match = match_email_to_person(addresses, person)
            if not match:
                continue

            return EmailFinding(
                email=match,
                source=SOURCE,
                source_url=url,
                confidence=confidence,
            )

    return EmailFinding()
