"""OpenAlex — the primary source for both papers and people.

Live probing settled the source hierarchy. OpenAlex returns, in one call per
work: ROR-linked institutions with ISO country codes, an affiliation *year
series* per author, scored keywords, topics, and the full reference list. IEEE's
search endpoint returns none of that, and Semantic Scholar's author endpoints
refuse unauthenticated traffic outright.

OpenAlex is CC0, so unlike IEEE its records may be cached locally without
restriction — another reason the accumulating store is built around it.

Abstracts arrive as an inverted index and are reconstructed on the way in.
"""

from __future__ import annotations

from typing import Any

from academia.core.http import build_url, get_json
from academia.core.models import Author, Paper, Person, position_label
from academia.core.paths import contact_email
from academia.core.text import as_text, invert_abstract, normalize_orcid, optional_int
from academia.sources.base import AuthorSource, PaperSource, SearchPage

WORKS_URL = "https://api.openalex.org/works"
AUTHORS_URL = "https://api.openalex.org/authors"
SOURCE = "openalex"

#: Keywords come with a relevance score; below this they are noise.
KEYWORD_SCORE_FLOOR = 0.3


def _short_id(value: Any) -> str:
    """``https://openalex.org/W123`` -> ``W123``."""
    text = as_text(value)
    return text.rsplit("/", 1)[-1] if text else ""


def _polite(params: dict[str, Any]) -> dict[str, Any]:
    contact = contact_email()
    if contact:
        params["mailto"] = contact
    return params


def _authors_from(record: dict[str, Any]) -> list[Author]:
    """Author slots in list order.

    OpenAlex only labels ``first``/``middle``/``last`` and its
    ``corresponding_author_ids`` field was empty across every sampled work, so the
    list index is the authoritative signal and the label is a hint.
    """
    authorships = record.get("authorships") or []
    total = len(authorships)
    corresponding = {_short_id(i) for i in record.get("corresponding_author_ids") or []}

    authors: list[Author] = []
    for idx, entry in enumerate(authorships):
        if not isinstance(entry, dict):
            continue
        person = entry.get("author") or {}
        openalex_id = _short_id(person.get("id"))
        institutions = entry.get("institutions") or []
        first_institution = institutions[0] if institutions else {}
        authors.append(
            Author(
                name=as_text(person.get("display_name")),
                idx=idx,
                position=position_label(idx, total),
                is_corresponding=bool(entry.get("is_corresponding")) or openalex_id in corresponding,
                orcid=normalize_orcid(person.get("orcid")),
                openalex_id=openalex_id,
                raw_affiliation=as_text(first_institution.get("display_name")),
                country_code=as_text(first_institution.get("country_code")).upper(),
            )
        )
    return authors


def _terms_from(record: dict[str, Any]) -> list[tuple[str, str, float | None]]:
    terms: list[tuple[str, str, float | None]] = []
    for keyword in record.get("keywords") or []:
        score = keyword.get("score")
        if score is not None and score < KEYWORD_SCORE_FLOOR:
            continue
        name = as_text(keyword.get("display_name"))
        if name:
            terms.append((name, "keyword", score))
    for topic in record.get("topics") or []:
        name = as_text(topic.get("display_name"))
        if name:
            terms.append((name, "topic", topic.get("score")))
    return terms


def to_paper(record: dict[str, Any]) -> Paper:
    """Normalise one OpenAlex work."""
    primary = record.get("primary_location") or {}
    venue_source = primary.get("source") or {}
    best_oa = record.get("best_oa_location") or {}

    paper = Paper.build(
        title=as_text(record.get("display_name") or record.get("title")),
        source=SOURCE,
        doi=as_text(record.get("doi")),
        source_id=_short_id(record.get("id")),
        abstract=invert_abstract(record.get("abstract_inverted_index")),
        year=optional_int(record.get("publication_year")),
        venue=as_text(venue_source.get("display_name")),
        venue_type=as_text(record.get("type")),
        citation_count=optional_int(record.get("cited_by_count")),
        url=as_text(record.get("id")),
        pdf_url=as_text(best_oa.get("pdf_url")),
        # Publishers answer a direct PDF request with 403 far more often than
        # they block the landing page, and the landing page is where the
        # corresponding-author address is rendered as HTML.
        landing_page_url=as_text(best_oa.get("landing_page_url")),
    )
    paper.authors = _authors_from(record)
    paper.terms = _terms_from(record)
    paper.referenced_ids = [_short_id(r) for r in record.get("referenced_works") or []]
    return paper


def to_person(record: dict[str, Any]) -> Person:
    """Normalise one OpenAlex author profile, career history included."""
    from academia.core.models import Affiliation, Institution, stable_id

    openalex_id = _short_id(record.get("id"))
    person = Person(
        person_id=stable_id("person", normalize_orcid(record.get("orcid")) or openalex_id),
        display_name=as_text(record.get("display_name")),
        orcid=normalize_orcid(record.get("orcid")),
        openalex_id=openalex_id,
        confidence=0.99 if record.get("orcid") else 0.9,
        resolution_method="orcid" if record.get("orcid") else "openalex_id",
    )
    person.names = [as_text(n) for n in record.get("display_name_alternatives") or []]
    person.topics = [as_text(t.get("display_name")) for t in record.get("topics") or []][:8]

    last_known = {
        _short_id(i.get("id")) for i in record.get("last_known_institutions") or [] if isinstance(i, dict)
    }
    for entry in record.get("affiliations") or []:
        institution = entry.get("institution") or {}
        name = as_text(institution.get("display_name"))
        if not name:
            continue
        years = sorted(y for y in (entry.get("years") or []) if isinstance(y, int))
        built = Institution.build(
            name=name,
            ror_id=as_text(institution.get("ror")),
            country_code=as_text(institution.get("country_code")).upper(),
            type=as_text(institution.get("type")),
        )
        person.affiliations.append(
            Affiliation(
                inst_id=built.inst_id,
                institution=name,
                country_code=built.country_code,
                year_from=years[0] if years else None,
                year_to=years[-1] if years else None,
                is_current=_short_id(institution.get("id")) in last_known,
                kind=as_text(institution.get("type")),
                source=SOURCE,
                source_url=as_text(record.get("id")),
            )
        )
    return person


class OpenAlex(PaperSource, AuthorSource):
    """Works search plus author enrichment."""

    request_delay = 0.15

    WORK_SELECT = (
        "id,doi,display_name,publication_year,type,cited_by_count,primary_location,"
        "best_oa_location,authorships,corresponding_author_ids,keywords,topics,"
        "referenced_works,abstract_inverted_index"
    )
    AUTHOR_SELECT = (
        "id,orcid,display_name,display_name_alternatives,affiliations,"
        "last_known_institutions,topics,works_count,cited_by_count"
    )

    @property
    def name(self) -> str:
        return SOURCE

    def adapt_expression(self, expression: str) -> str:
        """OpenAlex full-text search has no boolean grammar — strip the operators.

        Passing ``AND``/``OR``/quotes through would have them matched as literal
        words, quietly wrecking relevance.
        """
        cleaned = expression.replace('"', " ")
        for operator in (" AND ", " OR ", " NOT ", "(", ")"):
            cleaned = cleaned.replace(operator, " ")
        return " ".join(cleaned.split())

    def search(
        self,
        expression: str,
        query_id: str,
        *,
        page: int = 1,
        per_page: int = 25,
        year_from: int | None = None,
        year_to: int | None = None,
        timeout: int = 30,
    ) -> SearchPage:
        filters = []
        if year_from:
            filters.append(f"from_publication_date:{year_from}-01-01")
        if year_to:
            filters.append(f"to_publication_date:{year_to}-12-31")

        url = build_url(
            WORKS_URL,
            _polite(
                {
                    "search": self.adapt_expression(expression),
                    "per-page": min(per_page, 200),
                    "page": page,
                    "select": self.WORK_SELECT,
                    "filter": ",".join(filters) if filters else None,
                }
            ),
        )
        data = get_json(url, SOURCE, timeout=timeout)
        results = [r for r in data.get("results") or [] if isinstance(r, dict)]
        return SearchPage(
            source=SOURCE,
            query_id=query_id,
            page=page,
            total_count=int((data.get("meta") or {}).get("count") or len(results)),
            papers=[to_paper(r) for r in results],
            raw=data,
        )

    def get_author(self, author_id: str, *, timeout: int = 30) -> Person | None:
        url = build_url(
            f"{AUTHORS_URL}/{_short_id(author_id)}", _polite({"select": self.AUTHOR_SELECT})
        )
        from academia.core.errors import SourceError

        try:
            return to_person(get_json(url, SOURCE, timeout=timeout))
        except SourceError as error:
            if error.details.get("status") == 404:
                return None
            raise

    def find_author_by_orcid(self, orcid: str, *, timeout: int = 30) -> Person | None:
        clean = normalize_orcid(orcid)
        if not clean:
            return None
        return self.get_author(f"https://orcid.org/{clean}", timeout=timeout)

    def get_author_papers(self, author_id: str, *, limit: int = 50, timeout: int = 30) -> list[Paper]:
        url = build_url(
            WORKS_URL,
            _polite(
                {
                    "filter": f"author.id:{_short_id(author_id)}",
                    "per-page": min(limit, 200),
                    "sort": "publication_date:desc",
                    "select": self.WORK_SELECT,
                }
            ),
        )
        data = get_json(url, SOURCE, timeout=timeout)
        return [to_paper(r) for r in data.get("results") or [] if isinstance(r, dict)]
