"""Finding a reviewer's address in the literature they published.

This is where an editor looks by hand: the corresponding-author footnote of the
candidate's own papers. It is the highest-confidence source in the precedence
table and, until now, the only unwired one.

The approach is shaped by measurement rather than by what ought to work. On a
live sample of stored papers:

* 66% had an open-access PDF URL, but publishers answered a direct request for
  it with ``403 Forbidden`` (MDPI) or ``502`` (IEEE);
* the open-access **landing page** returned an address in 7 of 12 fetches,
  because it renders the footnote as HTML;
* repository copies (PubMed, figshare, DOAJ) yielded 0 of 9 — they hold
  metadata and abstracts, not the author block.

So this reads landing pages. It does not download PDFs, and it does not search
the open web for a person.

The safety property is unchanged and is the whole point: an address is only ever
attributed to a candidate when their own name matches its local part, or when
the structured record says they are the corresponding author of that exact
paper. A footnote address belongs to whoever corresponded, not to every author
on the paper, and inviting the wrong person is worse than inviting nobody.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

from academia.core.models import Person
from academia.reviewer.enrich import (
    EMAIL_CONFIDENCE,
    EmailFinding,
    extract_emails,
    match_email_to_person,
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
            SELECT p.paper_id, p.landing_page_url, a.is_corresponding
            FROM authorships a
            JOIN papers p ON p.paper_id = a.paper_id
            WHERE a.person_id = ?
              AND p.landing_page_url IS NOT NULL
              AND p.landing_page_url <> ''
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
) -> EmailFinding:
    """Look for the candidate's address in the front matter of their own papers.

    ``seen_pages`` memoises page text across candidates within one run. Two
    co-authors on the same paper are common in a candidate pool built from a
    single field, and the page should be fetched once.
    """
    if fetcher is None:
        return EmailFinding()

    cache = seen_pages if seen_pages is not None else {}
    for row in _candidate_papers(conn, person.person_id)[:MAX_PAPERS_PER_CANDIDATE]:
        url = row["landing_page_url"]
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
            confidence=EMAIL_CONFIDENCE[SOURCE],
        )

    return EmailFinding()


# ------------------------------------------------------- the manual bridge


def lookup_worklist(
    people: list[Person], *, resolved: set[str] | None = None
) -> list[dict[str, str]]:
    """Candidates with no address yet, with enough context to resolve one.

    Automatic discovery reaches roughly a fifth of candidates in this field, and
    that is a property of the data rather than a gap in the code: publisher
    landing pages refuse IEEE, MDPI and IET; no repository copies exist; and
    Crossref carries no addresses at all. Each of those was measured, not
    assumed.

    What closes the rest is a search — the thing an editor does by hand and the
    one step the CLI cannot take, having no search tool and no business
    guessing. So it hands over a worklist instead of a column of "not found",
    and accepts the answer back as a URL whose page it will read itself. The
    rule survives the detour: the address is still *found on a page*, never
    constructed from a name and a domain.

    ``resolved`` is the set of person ids that already have an address.
    """
    already = resolved or set()
    from academia.reviewer.seniority import UNKNOWN

    items: list[dict[str, str]] = []
    for person in people:
        needs = []
        if person.person_id not in already:
            needs.append("email")
        if person.rank == UNKNOWN and not person.stated_title:
            needs.append("position")
        if not needs:
            continue
        affiliation = person.current_affiliation
        institution = affiliation.institution if affiliation else ""
        query = " ".join(filter(None, [person.display_name, institution, "faculty profile"]))
        items.append(
            {
                "person_id": person.person_id,
                "name": person.display_name,
                "institution": institution,
                "orcid": person.orcid,
                "needs": needs,
                "suggested_query": query,
            }
        )
    return items


@dataclass
class Lookups:
    """What a search turned up, ready to be recorded with its provenance."""

    urls: dict[str, list[str]] = field(default_factory=dict)
    ranks: dict[str, tuple[str, str]] = field(default_factory=dict)


def read_lookups(path) -> Lookups:
    """Read the answers to a `rev-disc contacts` worklist.

    Three shapes per candidate, so the simple case stays simple::

        "person-1": "https://a.edu/x"
        "person-2": ["https://a.edu/x", "https://lab.example/y"]
        "person-3": {"urls": [...], "rank": "professor", "rank_source": "https://..."}

    A rank must come with the URL that stated it. Whoever did the search read a
    page; the dossier records which one, so the claim stays checkable — the same
    rule that governs addresses, applied to the one field a regex could not read
    reliably enough to be trusted.
    """
    import json
    from pathlib import Path

    from academia.core.errors import UsageError
    from academia.reviewer.seniority import KNOWN_RANKS

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageError(f"could not read {path}: {error}") from error
    if not isinstance(data, dict):
        raise UsageError(f"{path} must hold an object mapping person_id to a URL or list")

    lookups = Lookups()
    for person_id, value in data.items():
        key = str(person_id)
        if isinstance(value, dict):
            raw_urls = value.get("urls") or []
            rank = as_text_or_empty(value.get("rank"))
            if rank:
                if rank not in KNOWN_RANKS:
                    raise UsageError(
                        f"{key}: unrecognised rank {rank!r}. "
                        f"Expected one of: {', '.join(sorted(KNOWN_RANKS))}"
                    )
                source = as_text_or_empty(value.get("rank_source"))
                if not source:
                    raise UsageError(
                        f"{key}: a rank needs rank_source — the URL of the page stating it"
                    )
                lookups.ranks[key] = (rank, source)
        else:
            raw_urls = value

        urls = [raw_urls] if isinstance(raw_urls, str) else list(raw_urls or [])
        cleaned = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
        if cleaned:
            lookups.urls[key] = cleaned
    return lookups


def as_text_or_empty(value) -> str:
    return str(value).strip() if isinstance(value, str) else ""


def read_homepage_file(path) -> dict[str, list[str]]:
    """Read ``{person_id: url | [url, ...]}`` written by whoever did the search."""
    import json
    from pathlib import Path

    from academia.core.errors import UsageError

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageError(f"could not read {path}: {error}") from error
    if not isinstance(data, dict):
        raise UsageError(f"{path} must hold an object mapping person_id to a URL or list")

    resolved: dict[str, list[str]] = {}
    for person_id, value in data.items():
        urls = [value] if isinstance(value, str) else list(value or [])
        cleaned = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
        if cleaned:
            resolved[str(person_id)] = cleaned
    return resolved
