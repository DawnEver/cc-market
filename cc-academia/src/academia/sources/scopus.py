"""Scopus — journal articles with the author position attached.

Two properties of the response are why this source exists:

* ``view=COMPLETE`` returns the **ordered author list** of every document, each
  slot carrying ``authid`` and a 1-based ``@seq``. Author position is therefore
  read off the record rather than searched for, which turns "first-author
  papers" into a count instead of an estimate.
* ``SRCTYPE(j) AND (DOCTYPE(ar) OR DOCTYPE(re))`` restricts to journal articles
  and reviews, the unit bibliometric questions are asked in.

Four findings from live probing are encoded below, because each one fails
silently or misleadingly:

1. ``AUTHLAST()`` is an **author-search** field. Used in a document search it is
   a 400 "Error translating query". Document search spells it ``AUTH()``.
2. Two bare ``AUTH()`` terms ANDed together do **not** intersect. A probe for
   ``AUTH(kumar) AND AUTH(clare)`` answered with *Genome Biology* and *Physical
   Review Letters* — documents containing neither name. Only
   ``AU-ID(<id>) AND AUTH(<name>)`` is dependable, and it is the only
   conjunction this module builds.
3. A search finding one result returns an **object** where a list is expected,
   and a search finding none returns **one entry carrying ``error``** rather
   than an empty list. Code that tests truthiness sees "one result" in both
   cases, which is how an earlier pass read "no such person" as "found one" and
   discarded the match it was looking for.
4. A page size of 25 is not a preference. The service level answers 100 and 200
   with ``INVALID_INPUT ... Exceeds the maximum number allowed for the service
   level``.

Author identity here follows the house rule rather than bending it: a Scopus
author id is a persistent identifier, so it *is* an identity once established,
and :func:`to_person` records it as one. But a profile reached by searching a
name has not been established by that search, so it is a *candidate* carrying
its evidence (:class:`AuthorCandidate`) and only :func:`admit_candidate` turns
one into an accepted identity — refusing when two are supported equally.
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from academia.core.http import build_url, get_json
from academia.core.models import Author, Paper, Person, position_label
from academia.core.text import (
    as_text,
    name_keys,
    optional_int,
    split_person_name,
)
from academia.sources.base import AuthorSource, PaperSource, SearchPage

SEARCH_URL = "https://api.elsevier.com/content/search"
AUTHOR_URL = "https://api.elsevier.com/content/author/author_id"
SOURCE = "scopus"

#: The largest page this API's service level accepts. See the module docstring.
PAGE_SIZE = 25

#: Document types counted as a journal paper. Matched on ``subtypeDescription``,
#: which is the field the response actually labels; ``prism:aggregationType``
#: says only "Journal" and cannot separate a review from an article.
JOURNAL_TYPES = frozenset({"Article", "Review"})

#: The query fragment that yields exactly those.
JOURNAL_QUERY = "SRCTYPE(j) AND (DOCTYPE(ar) OR DOCTYPE(re))"

#: Field prefixes that mean an expression is already written in Scopus's
#: grammar and must not be wrapped again.
_FIELD_PREFIXES = ("TITLE", "ABS", "KEY", "AUTH", "AU-ID", "SRCTYPE", "DOCTYPE", "AFFIL", "PUBYEAR")


def api_key() -> str:
    return os.environ.get("SCOPUS_API_KEY", "").strip()


def inst_token() -> str:
    """The institutional token, sent only when set.

    Most university keys do not need one. An empty header is not the same as an
    absent header to this API, so it is omitted rather than blanked.
    """
    return os.environ.get("SCOPUS_INST_TOKEN", "").strip()


def _headers() -> dict[str, str]:
    """Credential headers, read at call time so a test can set them late."""
    headers = {"Accept": "application/json"}
    key = api_key()
    if key:
        headers["X-ELS-APIKey"] = key
    token = inst_token()
    if token:
        headers["X-ELS-Insttoken"] = token
    return headers


def _short_id(value: Any) -> str:
    """``SCOPUS_ID:85123456789`` / ``AUTHOR_ID:7001234567`` -> the bare number."""
    text = as_text(value)
    return text.rsplit(":", 1)[-1] if text else ""


def _results(payload: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
    """``(total, entries)`` from either search service, with trap 3 handled."""
    results = payload.get("search-results") or {}
    try:
        total = int(results.get("opensearch:totalResults") or 0)
    except (TypeError, ValueError):
        total = 0
    entry = results.get("entry") or []
    if isinstance(entry, dict):
        entry = [entry]
    return total, [e for e in entry if isinstance(e, dict) and not e.get("error")]


def _one(payload: dict[str, Any]) -> dict[str, Any]:
    """The single body of a retrieval service, which may arrive wrapped in a list."""
    body = payload.get("author-retrieval-response") or {}
    if isinstance(body, list):
        body = body[0] if body else {}
    return body if isinstance(body, dict) else {}


# ------------------------------------------------------------------ queries


def search_documents(
    query: str, *, start: int = 0, count: int = PAGE_SIZE, view: str = "COMPLETE", timeout: int = 30
) -> tuple[int, list[dict[str, Any]]]:
    """One page of a document search. ``COMPLETE`` is what carries the authors."""
    url = build_url(
        f"{SEARCH_URL}/scopus",
        {"query": query, "start": start, "count": min(count, PAGE_SIZE), "view": view},
    )
    return _results(get_json(url, SOURCE, headers=_headers(), timeout=timeout))


def search_authors(
    query: str, *, start: int = 0, count: int = PAGE_SIZE, timeout: int = 30
) -> tuple[int, list[dict[str, Any]]]:
    """One page of an author search. This is the service ``AUTHLAST`` belongs to."""
    url = build_url(
        f"{SEARCH_URL}/author", {"query": query, "start": start, "count": min(count, PAGE_SIZE)}
    )
    return _results(get_json(url, SOURCE, headers=_headers(), timeout=timeout))


def get_author_profile(author_id: str, *, timeout: int = 30) -> dict[str, Any]:
    """The raw author record, or ``{}`` when the id is not a profile."""
    from academia.core.errors import SourceError

    url = build_url(f"{AUTHOR_URL}/{_short_id(author_id)}", {"view": "ENHANCED"})
    try:
        return _one(get_json(url, SOURCE, headers=_headers(), timeout=timeout))
    except SourceError as error:
        if error.details.get("status") == 404:
            return {}
        raise


def count_documents(query: str, *, timeout: int = 30) -> int:
    """How many documents match.

    One request, and the cheapest question this API answers — which is what
    makes "has this profile ever published with that person?" affordable to ask
    of every candidate rather than only of the one already believed.
    """
    return search_documents(query, count=1, view="STANDARD", timeout=timeout)[0]


def author_query(author_id: str, *, journals_only: bool = True) -> str:
    """Everything one author wrote, or only their journal articles and reviews."""
    query = f"AU-ID({_short_id(author_id)})"
    return f"{query} AND {JOURNAL_QUERY}" if journals_only else query


def coauthorship_query(author_id: str, names: Iterable[str]) -> str:
    """Documents this author wrote with anyone bearing one of these surnames.

    The only conjunction that behaves (finding 2). The surname match is loose
    on purpose: this decides whether a profile is worth fetching, and the
    ordered author lists of what it returns decide the rest.
    """
    surnames = sorted({split_person_name(name)[0] for name in names if as_text(name)})
    joined = " OR ".join(f"AUTH({surname})" for surname in surnames if surname)
    base = f"AU-ID({_short_id(author_id)})"
    return f"{base} AND ({joined})" if joined else base


# -------------------------------------------------------------- normalising


def _year(record: dict[str, Any]) -> int | None:
    return optional_int(as_text(record.get("prism:coverDate"))[:4])


def _authors_from(record: dict[str, Any]) -> list[Author]:
    """Author slots in published order.

    Scopus states the order twice — the list position and a 1-based ``@seq``.
    The list is authoritative and ``@seq`` is the corroboration, because a
    record that arrives without ``@seq`` must not read as one whose first
    author is unknown.
    """
    entries = record.get("author") or []
    if isinstance(entries, dict):
        entries = [entries]
    entries = [e for e in entries if isinstance(e, dict)]
    total = len(entries)
    authors: list[Author] = []
    for idx, entry in enumerate(entries):
        seq = optional_int(entry.get("@seq"))
        authors.append(
            Author(
                name=as_text(entry.get("authname")),
                idx=idx,
                position=position_label((seq - 1) if seq else idx, total),
                scopus_id=as_text(entry.get("authid")),
                # The web API carries no per-author affiliation; affiliations
                # come from OpenAlex. Left empty rather than guessed.
                raw_affiliation="",
                country_code="",
            )
        )
    return authors


def to_paper(record: dict[str, Any]) -> Paper:
    """Normalise one Scopus document."""
    paper = Paper.build(
        title=as_text(record.get("dc:title")),
        source=SOURCE,
        doi=as_text(record.get("prism:doi")),
        source_id=_short_id(record.get("dc:identifier")),
        year=_year(record),
        venue=as_text(record.get("prism:publicationName")),
        venue_type=as_text(record.get("subtypeDescription")),
        citation_count=optional_int(record.get("citedby-count")),
        url=as_text(record.get("prism:url")),
    )
    paper.authors = _authors_from(record)
    return paper


def is_journal_article(record: dict[str, Any]) -> bool:
    """Whether a document search result is a journal article or review."""
    return (
        as_text(record.get("subtypeDescription")) in JOURNAL_TYPES
        and as_text(record.get("prism:aggregationType")).lower() == "journal"
    )


def author_position(record: dict[str, Any], scopus_id: str) -> str:
    """Where one author sits on a document: ``first``/``second``/``last``/``middle``.

    Empty when that author is not on it. Read from the ordered list, so a
    document that lists no authors yields empty rather than "first" — the
    difference between an unknown position and a promotion.
    """
    target = _short_id(scopus_id)
    if not target:
        return ""
    for author in _authors_from(record):
        if author.scopus_id == target:
            return author.position
    return ""


def to_person(record: dict[str, Any], *, corroborated: bool = False) -> Person:
    """Normalise an author-search entry or an author-retrieval response.

    ``corroborated`` is what separates a candidate from an identity. A Scopus
    author id reached by searching a name is a *proposal*: it carries the
    ``name_only`` rung and the low confidence that rung means, and the caller
    raises it only when the evidence in :func:`find_author_candidates` supports
    it. Defaulting the other way would let a name search mint identity.
    """
    from academia.core.models import stable_id

    profile = record.get("author-profile") or {}
    core = record.get("coredata") or {}
    scopus_id = _short_id(core.get("dc:identifier")) or _short_id(record.get("dc:identifier"))
    preferred = profile.get("preferred-name") or record.get("preferred-name") or {}
    display = " ".join(
        part
        for part in (as_text(preferred.get("given-name")), as_text(preferred.get("surname")))
        if part
    )
    person = Person(
        person_id=stable_id("person", f"scopus:{scopus_id}"),
        display_name=display or as_text(preferred.get("indexed-name")) or scopus_id,
        scopus_id=scopus_id,
        confidence=0.85 if corroborated else 0.3,
        resolution_method="scopus_id" if corroborated else "name_only",
    )
    # Name variants are alternate spellings of one profile, not other people.
    fallback = as_text(preferred.get("indexed-name"))
    person.names = [n for n in (display, fallback) if n]
    # ``works_by_year`` stays empty: ``coredata.document-count`` is one total
    # for the whole career, and a total is not a series. Filling it would put a
    # number in a per-year field and every later sum would be wrong.
    current = record.get("affiliation-current") or {}
    if as_text(current.get("affiliation-name")):
        person.affiliations.append(_affiliation(current, scopus_id))
    return person


def _affiliation(current: dict[str, Any], scopus_id: str):
    """The profile's current affiliation, which is where they are *now*."""
    from academia.core.models import Affiliation, Institution

    name = as_text(current.get("affiliation-name"))
    built = Institution.build(
        name=name, country_code=as_text(current.get("affiliation-country")).upper()
    )
    return Affiliation(
        inst_id=built.inst_id,
        institution=name,
        country_code=built.country_code,
        is_current=True,
        source=SOURCE,
        source_url=f"{AUTHOR_URL}/{scopus_id}",
    )


# --------------------------------------------------------------- candidates


@dataclass(frozen=True, slots=True)
class AuthorCandidate:
    """A proposed Scopus profile, with the evidence that proposed it."""

    person: Person
    #: Documents shared with the named corroborators. 0 when none were given.
    shared_documents: int = 0
    #: ``corroborated``, ``affiliation`` or ``name`` — how it was reached.
    evidence: str = "name"

    @property
    def scopus_id(self) -> str:
        return self.person.scopus_id


def find_author_candidates(
    name: str,
    *,
    corroborators: Sequence[str] = (),
    affiliation: str = "",
    max_candidates: int = 12,
    timeout: int = 30,
) -> list[AuthorCandidate]:
    """Propose Scopus profiles for a person a record names.

    A name is a search key here, never an identity. What comes back is a list
    of candidates each carrying its evidence, strongest first, and
    :func:`admit_candidate` decides whether any of them may be believed.

    ``corroborators`` are people the *record* says worked with this person — a
    doctoral supervisor, say. When any are given, only profiles that share a
    document with one of them are returned: this is the evidence that licenses
    a proposal, and returning uncorroborated namesakes alongside it would invite
    exactly the mis-attachment this design exists to prevent.

    Supplying ``affiliation`` narrows the author search, which matters for a
    common surname: the search ranks by output, so a recent graduate with two
    papers never reaches the first page of a "Wang". It is a hint, not a
    filter — a graduate who has since moved is still the person, so a narrowed
    search that finds nobody falls back to the unnarrowed one.
    """
    surname, given = split_person_name(name)
    if not surname:
        return []
    wanted = name_keys(name)

    # Widen in stages, cheapest and most precise first. Dropping the given name
    # is the last resort because it is the widest: for a common surname it
    # returns a page of namesakes, and every one of them then costs a
    # corroboration query.
    attempts = [affiliation, ""] if affiliation else [""]
    entries: list[dict[str, Any]] = []
    for narrowing in attempts:
        entries = _author_search(surname, given, narrowing, timeout=timeout)
        if entries:
            break
    if not entries and given:
        entries = _author_search(surname, "", "", timeout=timeout)

    seen: dict[str, dict[str, Any]] = {}
    for entry in entries:
        preferred = entry.get("preferred-name") or {}
        scopus_id = _short_id(entry.get("dc:identifier"))
        if not scopus_id or scopus_id in seen:
            continue
        found = f"{as_text(preferred.get('given-name'))} {as_text(preferred.get('surname'))}"
        # A profile whose own spelling disagrees with the record is a namesake:
        # "Kumar, Ravi" must not answer for "Kumar, Dinesh". Comparing key *sets*
        # rather than single keys is what keeps this tolerant of the one thing
        # that is genuinely undecidable — a name written without a comma, where
        # either word order may be the surname.
        if not name_keys(found) & wanted:
            continue
        seen[scopus_id] = entry

    candidates: list[AuthorCandidate] = []
    for scopus_id, entry in list(seen.items())[:max_candidates]:
        if corroborators:
            shared = count_documents(coauthorship_query(scopus_id, corroborators), timeout=timeout)
            if not shared:
                continue
            candidates.append(
                AuthorCandidate(to_person(entry, corroborated=True), shared, "corroborated")
            )
        else:
            candidates.append(AuthorCandidate(to_person(entry), 0, "name"))
    candidates.sort(key=lambda c: -c.shared_documents)
    return candidates


def _author_search(
    surname: str, given: str, affiliation: str, *, timeout: int
) -> list[dict[str, Any]]:
    """One author-search query, built from whatever narrowing the caller wants.

    ``AUTHFIRST`` matches a **single** given name: handing it "alex taiwo"
    returns nothing at all rather than a superset, so only the first token is
    sent. A query that finds nothing comes back as one entry carrying ``error``
    rather than an empty list (finding 3), which :func:`search_authors` filters
    — so an empty return here means no profile, not a payload to be inspected.
    """
    first = given.split()[0] if given else ""
    query = f'AUTHLAST("{surname}")'
    if first:
        query += f' AND AUTHFIRST("{first}")'
    if affiliation:
        query += f" AND AFFIL({affiliation})"
    return search_authors(query, timeout=timeout)[1]


def admit_candidate(candidates: Sequence[AuthorCandidate]) -> AuthorCandidate | None:
    """The one candidate the evidence admits, or ``None``.

    ``None`` covers both "nothing was proposed" and "several were proposed
    equally", and a caller must tell those apart in what it reports — the first
    is *not found*, the second is *ambiguous*. Collapsing them here is
    deliberate: guessing between two equally supported profiles is how one
    person's publication record gets attached to another, and a missing count
    is recoverable in a way a wrong one is not.
    """
    if not candidates:
        return None
    best = max(candidates, key=lambda c: c.shared_documents)
    if best.shared_documents <= 0:
        return None
    tied = [c for c in candidates if c.shared_documents == best.shared_documents]
    return best if len(tied) == 1 else None


# ------------------------------------------------------------------- source


class Scopus(PaperSource, AuthorSource):
    """Document search plus author lookup."""

    request_delay = 0.4

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """Wrap a bare boolean expression in Scopus's default field.

        Scopus has no unqualified full-text search: ``"torque ripple" AND
        "axial flux"`` is a syntax error, and the field it has to be scoped to
        is ``TITLE-ABS-KEY``. An expression that already names a field is left
        alone, so a caller that knows the grammar keeps control of it.
        """
        text = " ".join(as_text(expression).split())
        if not text:
            return text
        upper = text.upper()
        if any(prefix in upper for prefix in _FIELD_PREFIXES):
            return text
        return f"TITLE-ABS-KEY({text})"

    def search(
        self,
        expression: str,
        query_id: str,
        *,
        page: int = 1,
        per_page: int = PAGE_SIZE,
        year_from: int | None = None,
        year_to: int | None = None,
        timeout: int = 30,
    ) -> SearchPage:
        size = min(per_page, PAGE_SIZE)
        query = self.adapt_expression(expression)
        bounds = []
        if year_from:
            bounds.append(f"PUBYEAR > {year_from - 1}")
        if year_to:
            bounds.append(f"PUBYEAR < {year_to + 1}")
        if bounds:
            query = f"({query}) AND " + " AND ".join(bounds)

        total, entries = search_documents(
            query, start=(page - 1) * size, count=size, timeout=timeout
        )
        return SearchPage(
            source=SOURCE,
            query_id=query_id,
            page=page,
            total_count=total,
            papers=[to_paper(entry) for entry in entries],
            raw={"query": query, "total": total},
        )

    def get_author(self, author_id: str, *, timeout: int = 30) -> Person | None:
        """Fetch a profile by Scopus author id.

        Corroboration is not this call's business: an id that is already in hand
        is an identity, and the caller that obtained it by searching a name is
        the one that owed the evidence.
        """
        record = get_author_profile(author_id, timeout=timeout)
        return to_person(record, corroborated=True) if record else None

    def get_author_papers(
        self,
        author_id: str,
        *,
        limit: int = 50,
        timeout: int = 30,
        journals_only: bool = False,
    ) -> list[Paper]:
        """An author's documents, newest first.

        ``journals_only`` restricts to articles and reviews. It is a parameter
        rather than the default because a generic caller asking for "works"
        means works; a bibliometric caller counting papers in a venue type
        should say so and then still check ``Paper.venue_type``.
        """
        pages = -(-limit // PAGE_SIZE)
        papers: list[Paper] = []
        for page in range(pages):
            _total, entries = search_documents(
                author_query(author_id, journals_only=journals_only),
                start=page * PAGE_SIZE,
                count=PAGE_SIZE,
                timeout=timeout,
            )
            if not entries:
                break
            papers.extend(to_paper(entry) for entry in entries)
            if len(entries) < PAGE_SIZE:
                break
        return papers[:limit]
