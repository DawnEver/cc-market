"""Read and write the accumulating store.

Everything here is upsert-or-append. A second run over the same topic must enrich
what is already there rather than duplicate it — that is the entire value of
keeping a local database instead of re-querying every time.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from typing import Any

from academia.core.models import (
    Affiliation,
    Author,
    Education,
    Institution,
    Paper,
    Person,
    stable_id,
    utcnow,
)
from academia.core.text import normalize_name, normalize_orcid, normalize_title

# --------------------------------------------------------------------- papers


def upsert_paper(conn: sqlite3.Connection, paper: Paper) -> str:
    """Insert or enrich a paper. Existing non-empty fields are never blanked."""
    row = paper.to_row()
    conn.execute(
        """
        INSERT INTO papers (paper_id, doi, title, abstract, year, venue, venue_type,
                            citation_count, source, source_id, url, first_seen, last_seen)
        VALUES (:paper_id, :doi, :title, :abstract, :year, :venue, :venue_type,
                :citation_count, :source, :source_id, :url, :first_seen, :last_seen)
        ON CONFLICT(paper_id) DO UPDATE SET
            doi            = coalesce(nullif(excluded.doi, ''), papers.doi),
            abstract       = coalesce(nullif(excluded.abstract, ''), papers.abstract),
            year           = coalesce(excluded.year, papers.year),
            venue          = coalesce(nullif(excluded.venue, ''), papers.venue),
            venue_type     = coalesce(nullif(excluded.venue_type, ''), papers.venue_type),
            citation_count = coalesce(excluded.citation_count, papers.citation_count),
            url            = coalesce(nullif(excluded.url, ''), papers.url),
            last_seen      = excluded.last_seen
        """,
        row,
    )

    if paper.terms:
        conn.executemany(
            """
            INSERT INTO paper_terms (paper_id, term, kind, score)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(paper_id, term, kind) DO UPDATE SET score = coalesce(excluded.score, paper_terms.score)
            """,
            [(paper.paper_id, term, kind, score) for term, kind, score in paper.terms],
        )

    if paper.referenced_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO paper_refs (paper_id, referenced_paper_id) VALUES (?, ?)",
            [(paper.paper_id, ref) for ref in paper.referenced_ids],
        )

    return paper.paper_id


def search_papers(conn: sqlite3.Connection, query: str, limit: int = 50) -> list[sqlite3.Row]:
    """BM25-ranked full-text search. FTS5 returns lower scores for better matches."""
    return conn.execute(
        """
        SELECT p.*, bm25(papers_fts) AS bm25_score
        FROM papers_fts
        JOIN papers p ON p.rowid = papers_fts.rowid
        WHERE papers_fts MATCH ?
        ORDER BY bm25_score
        LIMIT ?
        """,
        (query, limit),
    ).fetchall()


def get_paper(conn: sqlite3.Connection, paper_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM papers WHERE paper_id = ?", (paper_id,)).fetchone()


# -------------------------------------------------------------------- people


def _find_person_id(conn: sqlite3.Connection, author: Author) -> str | None:
    """Identity lookup in strict precedence order.

    ORCID first (89% coverage in the target domain), then persistent source ids.
    Name matching is never used here — a live probe for a common name returned a
    researcher from an unrelated field.
    """
    for column, value in (
        ("orcid", normalize_orcid(author.orcid)),
        ("openalex_id", author.openalex_id),
        ("ieee_author_id", author.ieee_author_id),
        ("s2_id", author.s2_id),
    ):
        if not value:
            continue
        row = conn.execute(
            f"SELECT person_id FROM persons WHERE {column} = ?", (value,)
        ).fetchone()
        if row:
            return row["person_id"]
    return None


def _resolution_for(author: Author) -> tuple[str, float]:
    if normalize_orcid(author.orcid):
        return "orcid", 0.99
    if author.openalex_id:
        return "openalex_id", 0.9
    if author.ieee_author_id:
        return "ieee_author_id", 0.85
    if author.s2_id:
        return "s2_id", 0.8
    return "name_only", 0.3


def upsert_person(conn: sqlite3.Connection, author: Author) -> str:
    """Resolve an author slot to a person row, creating it when new."""
    person_id = _find_person_id(conn, author)
    method, confidence = _resolution_for(author)
    now = utcnow()

    if person_id is None:
        seed = (
            normalize_orcid(author.orcid)
            or author.openalex_id
            or author.ieee_author_id
            or author.s2_id
            or f"name:{author.name_key}"
        )
        person_id = stable_id("person", seed)
        conn.execute(
            """
            INSERT INTO persons (person_id, display_name, orcid, openalex_id, ieee_author_id,
                                 s2_id, confidence, resolution_method, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET last_seen = excluded.last_seen
            """,
            (
                person_id,
                author.name,
                normalize_orcid(author.orcid) or None,
                author.openalex_id or None,
                author.ieee_author_id or None,
                author.s2_id or None,
                confidence,
                method,
                now,
                now,
            ),
        )
    else:
        # Merge newly-learned identifiers; a better identifier upgrades confidence.
        conn.execute(
            """
            UPDATE persons SET
                orcid             = coalesce(nullif(?, ''), orcid),
                openalex_id       = coalesce(nullif(?, ''), openalex_id),
                ieee_author_id    = coalesce(nullif(?, ''), ieee_author_id),
                s2_id             = coalesce(nullif(?, ''), s2_id),
                confidence        = max(confidence, ?),
                resolution_method = CASE WHEN ? > confidence THEN ? ELSE resolution_method END,
                last_seen         = ?
            WHERE person_id = ?
            """,
            (
                normalize_orcid(author.orcid),
                author.openalex_id,
                author.ieee_author_id,
                author.s2_id,
                confidence,
                confidence,
                method,
                now,
                person_id,
            ),
        )

    conn.execute(
        "INSERT OR IGNORE INTO person_names (person_id, name_variant) VALUES (?, ?)",
        (person_id, author.name),
    )
    return person_id


def add_name_variants(conn: sqlite3.Connection, person_id: str, variants: Iterable[str]) -> None:
    conn.executemany(
        "INSERT OR IGNORE INTO person_names (person_id, name_variant) VALUES (?, ?)",
        [(person_id, v) for v in variants if v],
    )


def get_person(conn: sqlite3.Connection, person_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM persons WHERE person_id = ?", (person_id,)).fetchone()


def find_person_by_name(conn: sqlite3.Connection, name: str) -> list[sqlite3.Row]:
    """Name lookup, for COI exclusion only — never for recommendation."""
    key = normalize_name(name)
    rows = conn.execute(
        """
        SELECT DISTINCT p.* FROM persons p
        JOIN person_names n ON n.person_id = p.person_id
        """
    ).fetchall()
    return [r for r in rows if normalize_name(r["display_name"]) == key or _matches_variant(conn, r["person_id"], key)]


def _matches_variant(conn: sqlite3.Connection, person_id: str, key: str) -> bool:
    variants = conn.execute(
        "SELECT name_variant FROM person_names WHERE person_id = ?", (person_id,)
    ).fetchall()
    return any(normalize_name(v["name_variant"]) == key for v in variants)


# --------------------------------------------------------------- authorships


def record_authorships(conn: sqlite3.Connection, paper: Paper) -> list[str]:
    """Attach every author of a paper, returning their person ids in order."""
    person_ids: list[str] = []
    total = len(paper.authors)
    for author in paper.authors:
        person_id = upsert_person(conn, author)
        person_ids.append(person_id)
        conn.execute(
            """
            INSERT INTO authorships (paper_id, person_id, idx, position, is_corresponding, position_weight)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(paper_id, person_id) DO UPDATE SET
                idx              = excluded.idx,
                position         = excluded.position,
                is_corresponding = max(authorships.is_corresponding, excluded.is_corresponding),
                position_weight  = max(authorships.position_weight, excluded.position_weight)
            """,
            (
                paper.paper_id,
                person_id,
                author.idx,
                author.position,
                int(author.is_corresponding),
                author.weight,
            ),
        )
    _update_coauthor_edges(conn, person_ids, paper.year)
    del total
    return person_ids


def _update_coauthor_edges(conn: sqlite3.Connection, person_ids: Sequence[str], year: int | None) -> None:
    """Maintain an undirected co-authorship graph, stored once per unordered pair."""
    unique = sorted(set(person_ids))
    for i, a in enumerate(unique):
        for b in unique[i + 1 :]:
            conn.execute(
                """
                INSERT INTO coauthor_edges (a_person_id, b_person_id, paper_count, first_year, last_year)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(a_person_id, b_person_id) DO UPDATE SET
                    paper_count = coauthor_edges.paper_count + 1,
                    first_year  = min(coalesce(coauthor_edges.first_year, excluded.first_year), coalesce(excluded.first_year, coauthor_edges.first_year)),
                    last_year   = max(coalesce(coauthor_edges.last_year, excluded.last_year), coalesce(excluded.last_year, coauthor_edges.last_year))
                """,
                (a, b, year, year),
            )


def coauthors_of(conn: sqlite3.Connection, person_id: str, since_year: int | None = None) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT b_person_id AS other, paper_count, first_year, last_year
        FROM coauthor_edges WHERE a_person_id = ?
        UNION ALL
        SELECT a_person_id AS other, paper_count, first_year, last_year
        FROM coauthor_edges WHERE b_person_id = ?
        """,
        (person_id, person_id),
    ).fetchall()
    if since_year is None:
        return rows
    return [r for r in rows if (r["last_year"] or 0) >= since_year]


def papers_of(conn: sqlite3.Connection, person_id: str, limit: int = 50) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT p.*, a.idx, a.position, a.position_weight
        FROM authorships a JOIN papers p ON p.paper_id = a.paper_id
        WHERE a.person_id = ?
        ORDER BY coalesce(p.year, 0) DESC
        LIMIT ?
        """,
        (person_id, limit),
    ).fetchall()


# ---------------------------------------------------- institutions & career


def upsert_institution(conn: sqlite3.Connection, institution: Institution) -> str:
    conn.execute(
        """
        INSERT INTO institutions (inst_id, name, ror_id, country_code, city, type)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(inst_id) DO UPDATE SET
            ror_id       = coalesce(nullif(excluded.ror_id, ''), institutions.ror_id),
            country_code = coalesce(nullif(excluded.country_code, ''), institutions.country_code),
            city         = coalesce(nullif(excluded.city, ''), institutions.city),
            type         = coalesce(nullif(excluded.type, ''), institutions.type)
        """,
        (
            institution.inst_id,
            institution.name,
            institution.ror_id or None,
            institution.country_code or None,
            institution.city or None,
            institution.type or None,
        ),
    )
    return institution.inst_id


def record_affiliation(conn: sqlite3.Connection, person_id: str, aff: Affiliation) -> None:
    conn.execute(
        """
        INSERT INTO affiliations (person_id, inst_id, department, role, year_from, year_to,
                                  is_current, source, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(person_id, inst_id, year_from) DO UPDATE SET
            year_to    = coalesce(excluded.year_to, affiliations.year_to),
            is_current = max(affiliations.is_current, excluded.is_current),
            department = coalesce(nullif(excluded.department, ''), affiliations.department),
            source_url = coalesce(nullif(excluded.source_url, ''), affiliations.source_url)
        """,
        (
            person_id,
            aff.inst_id,
            aff.department or None,
            aff.role or None,
            aff.year_from,
            aff.year_to,
            int(aff.is_current),
            aff.source,
            aff.source_url or None,
        ),
    )


def record_education(conn: sqlite3.Connection, person_id: str, edu: Education) -> None:
    """Education is best-effort: ORCID fills it for roughly 30% of researchers.

    A row without a source URL is not recorded at all — an unsourced claim about
    someone's doctorate has no place in a reviewer dossier.
    """
    if not edu.source_url and edu.source != "orcid":
        return
    conn.execute(
        """
        INSERT INTO education (person_id, inst_id, degree, field, year_from, year_to,
                               advisor_person_id, source, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(person_id, inst_id, degree) DO UPDATE SET
            field             = coalesce(nullif(excluded.field, ''), education.field),
            year_from         = coalesce(excluded.year_from, education.year_from),
            year_to           = coalesce(excluded.year_to, education.year_to),
            advisor_person_id = coalesce(nullif(excluded.advisor_person_id, ''), education.advisor_person_id),
            source_url        = coalesce(nullif(excluded.source_url, ''), education.source_url)
        """,
        (
            person_id,
            edu.inst_id,
            edu.degree or None,
            edu.field or None,
            edu.year_from,
            edu.year_to,
            edu.advisor_person_id or None,
            edu.source,
            edu.source_url or None,
        ),
    )


def load_person(conn: sqlite3.Connection, person_id: str) -> Person | None:
    """Rehydrate a full Person, including career history."""
    row = get_person(conn, person_id)
    if row is None:
        return None

    person = Person(
        person_id=row["person_id"],
        display_name=row["display_name"],
        orcid=row["orcid"] or "",
        openalex_id=row["openalex_id"] or "",
        ieee_author_id=row["ieee_author_id"] or "",
        s2_id=row["s2_id"] or "",
        confidence=row["confidence"],
        resolution_method=row["resolution_method"],
    )
    person.names = [
        r["name_variant"]
        for r in conn.execute(
            "SELECT name_variant FROM person_names WHERE person_id = ?", (person_id,)
        )
    ]
    person.affiliations = [
        Affiliation(
            inst_id=r["inst_id"],
            institution=r["name"] or "",
            country_code=r["country_code"] or "",
            department=r["department"] or "",
            role=r["role"] or "",
            year_from=r["year_from"],
            year_to=r["year_to"],
            is_current=bool(r["is_current"]),
            source=r["source"],
            source_url=r["source_url"] or "",
        )
        for r in conn.execute(
            """
            SELECT a.*, i.name, i.country_code FROM affiliations a
            JOIN institutions i ON i.inst_id = a.inst_id
            WHERE a.person_id = ?
            ORDER BY coalesce(a.year_from, 0) DESC
            """,
            (person_id,),
        )
    ]
    person.education = [
        Education(
            inst_id=r["inst_id"],
            institution=r["name"] or "",
            degree=r["degree"] or "",
            field=r["field"] or "",
            year_from=r["year_from"],
            year_to=r["year_to"],
            advisor_person_id=r["advisor_person_id"] or "",
            source=r["source"],
            source_url=r["source_url"] or "",
        )
        for r in conn.execute(
            """
            SELECT e.*, i.name FROM education e
            JOIN institutions i ON i.inst_id = e.inst_id
            WHERE e.person_id = ?
            ORDER BY coalesce(e.year_to, e.year_from, 0)
            """,
            (person_id,),
        )
    ]
    return person


# ------------------------------------------------------------------- emails


def record_email(
    conn: sqlite3.Connection,
    person_id: str,
    email: str,
    *,
    source: str,
    source_url: str = "",
    confidence: float = 0.0,
) -> None:
    """Only ever called with an address that was actually observed somewhere public."""
    conn.execute(
        """
        INSERT INTO emails (person_id, email, source, source_url, confidence, verified_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(person_id, email) DO UPDATE SET
            confidence  = max(emails.confidence, excluded.confidence),
            source      = CASE WHEN excluded.confidence > emails.confidence THEN excluded.source ELSE emails.source END,
            source_url  = coalesce(nullif(excluded.source_url, ''), emails.source_url),
            verified_at = excluded.verified_at
        """,
        (person_id, email.lower(), source, source_url or None, confidence, utcnow()),
    )


def emails_of(conn: sqlite3.Connection, person_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM emails WHERE person_id = ? ORDER BY confidence DESC", (person_id,)
    ).fetchall()


# -------------------------------------------------------- runs and verdicts


def create_manuscript(
    conn: sqlite3.Connection,
    *,
    ms_id: str,
    journal: str,
    title_hash: str,
    origin_countries: Sequence[str],
) -> str:
    conn.execute(
        """
        INSERT INTO manuscripts (ms_id, journal, title_hash, origin_countries, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ms_id) DO UPDATE SET
            journal          = excluded.journal,
            origin_countries = excluded.origin_countries
        """,
        (ms_id, journal or None, title_hash, ",".join(origin_countries), utcnow()),
    )
    return ms_id


def add_manuscript_author(
    conn: sqlite3.Connection,
    ms_id: str,
    *,
    name: str,
    affiliation: str = "",
    country: str = "",
    person_id: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO manuscript_authors (ms_id, person_id, name, affiliation, country)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ms_id, name) DO UPDATE SET
            person_id   = coalesce(excluded.person_id, manuscript_authors.person_id),
            affiliation = coalesce(nullif(excluded.affiliation, ''), manuscript_authors.affiliation),
            country     = coalesce(nullif(excluded.country, ''), manuscript_authors.country)
        """,
        (ms_id, person_id, name, affiliation or None, country or None),
    )


def manuscript_authors(conn: sqlite3.Connection, ms_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM manuscript_authors WHERE ms_id = ?", (ms_id,)
    ).fetchall()


def create_run(conn: sqlite3.Connection, *, run_id: str, ms_id: str, config_hash: str = "") -> str:
    conn.execute(
        "INSERT OR REPLACE INTO runs (run_id, ms_id, created_at, config_hash) VALUES (?, ?, ?, ?)",
        (run_id, ms_id, utcnow(), config_hash or None),
    )
    return run_id


def record_score(
    conn: sqlite3.Connection,
    run_id: str,
    person_id: str,
    score: float,
    components: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO candidate_scores (run_id, person_id, score, components_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, person_id) DO UPDATE SET
            score = excluded.score, components_json = excluded.components_json
        """,
        (run_id, person_id, score, json.dumps(components, ensure_ascii=False)),
    )


def record_coi(
    conn: sqlite3.Connection,
    run_id: str,
    person_id: str,
    *,
    rule: str,
    status: str,
    evidence: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO coi_evidence (run_id, person_id, rule, status, evidence_json, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, person_id, rule) DO UPDATE SET
            status = excluded.status, evidence_json = excluded.evidence_json, checked_at = excluded.checked_at
        """,
        (run_id, person_id, rule, status, json.dumps(evidence, ensure_ascii=False), utcnow()),
    )


def coi_for(conn: sqlite3.Connection, run_id: str, person_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM coi_evidence WHERE run_id = ? AND person_id = ?", (run_id, person_id)
    ).fetchall()


def record_invitation(
    conn: sqlite3.Connection,
    person_id: str,
    ms_id: str,
    *,
    invited_at: str = "",
    responded: bool | None = None,
    accepted: bool | None = None,
    note: str = "",
) -> None:
    """Reviewer history is what makes the second manuscript cheaper than the first."""
    conn.execute(
        """
        INSERT INTO review_history (person_id, ms_id, invited_at, responded, accepted, quality_note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(person_id, ms_id) DO UPDATE SET
            responded    = coalesce(excluded.responded, review_history.responded),
            accepted     = coalesce(excluded.accepted, review_history.accepted),
            quality_note = coalesce(nullif(excluded.quality_note, ''), review_history.quality_note)
        """,
        (
            person_id,
            ms_id,
            invited_at or utcnow(),
            None if responded is None else int(responded),
            None if accepted is None else int(accepted),
            note or None,
        ),
    )


def invitation_history(conn: sqlite3.Connection, person_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM review_history WHERE person_id = ? ORDER BY invited_at DESC", (person_id,)
    ).fetchall()


def ingest_paper(conn: sqlite3.Connection, paper: Paper) -> tuple[str, list[str]]:
    """Store a paper together with its people. The one call the pipelines use."""
    upsert_paper(conn, paper)
    person_ids = record_authorships(conn, paper)
    return paper.paper_id, person_ids


def store_institution_for(
    conn: sqlite3.Connection,
    person_id: str,
    *,
    name: str,
    ror_id: str = "",
    country_code: str = "",
    department: str = "",
    year_from: int | None = None,
    year_to: int | None = None,
    is_current: bool = False,
    source: str = "openalex",
    source_url: str = "",
) -> str:
    """Convenience wrapper: create the institution then link the person to it."""
    institution = Institution.build(
        name=name, ror_id=ror_id, country_code=country_code
    )
    upsert_institution(conn, institution)
    record_affiliation(
        conn,
        person_id,
        Affiliation(
            inst_id=institution.inst_id,
            institution=name,
            country_code=country_code,
            department=department,
            year_from=year_from,
            year_to=year_to,
            is_current=is_current,
            source=source,
            source_url=source_url,
        ),
    )
    return institution.inst_id


def normalize_institution_key(name: str) -> str:
    return normalize_title(name)
