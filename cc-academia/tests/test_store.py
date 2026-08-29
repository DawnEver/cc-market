"""The store is the part that has to survive being run twice."""

from __future__ import annotations

import sqlite3

import pytest

from academia.core.models import Author, Paper, position_label, position_weight
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "test.db")
    yield connection
    connection.close()


def make_paper(**overrides):
    defaults = dict(
        title="Torque ripple suppression in PMSM drives",
        source="openalex",
        doi="10.1109/TIE.2024.0001",
        abstract="A method for suppressing torque ripple.",
        year=2024,
        venue="IEEE TIE",
    )
    defaults.update(overrides)
    authors = defaults.pop("authors", None)
    paper = Paper.build(**defaults)
    if authors is not None:
        paper.authors = authors
    return paper


def test_schema_is_idempotent(tmp_path):
    path = tmp_path / "x.db"
    db.initialize(path)
    db.initialize(path)
    assert db.table_counts(path)["papers"] == 0


def test_upsert_paper_enriches_instead_of_overwriting(conn):
    rich = make_paper()
    repo.upsert_paper(conn, rich)

    thin = make_paper(abstract="", venue="")
    thin.citation_count = 42
    repo.upsert_paper(conn, thin)

    row = repo.get_paper(conn, rich.paper_id)
    assert row["abstract"] == "A method for suppressing torque ripple."
    assert row["venue"] == "IEEE TIE"
    assert row["citation_count"] == 42


def test_same_doi_in_different_forms_is_one_paper(conn):
    a = make_paper(doi="10.1109/TIE.2024.0001")
    b = make_paper(doi="https://doi.org/10.1109/TIE.2024.0001", source="ieee")
    repo.upsert_paper(conn, a)
    repo.upsert_paper(conn, b)
    assert conn.execute("SELECT count(*) FROM papers").fetchone()[0] == 1


def test_fulltext_search_finds_by_abstract(conn):
    repo.upsert_paper(conn, make_paper())
    hits = repo.search_papers(conn, "torque ripple")
    assert len(hits) == 1
    assert hits[0]["title"].startswith("Torque ripple")


def test_person_resolves_by_orcid_across_name_variants(conn):
    orcid = "0000-0002-1825-0097"
    first = repo.upsert_person(conn, Author(name="Jian Wang", idx=0, orcid=orcid))
    second = repo.upsert_person(conn, Author(name="J. Wang", idx=1, orcid=orcid))
    assert first == second
    variants = {r["name_variant"] for r in conn.execute("SELECT name_variant FROM person_names")}
    assert variants == {"Jian Wang", "J. Wang"}


def test_person_resolution_upgrades_when_a_better_identifier_arrives(conn):
    person_id = repo.upsert_person(conn, Author(name="Jian Wang", idx=0, s2_id="S2-1"))
    assert repo.get_person(conn, person_id)["resolution_method"] == "s2_id"

    repo.upsert_person(conn, Author(name="Jian Wang", idx=0, s2_id="S2-1", orcid="0000-0002-1825-0097"))
    row = repo.get_person(conn, person_id)
    assert row["resolution_method"] == "orcid"
    assert row["confidence"] == pytest.approx(0.99)


def test_identical_names_without_identifiers_are_not_merged(conn):
    """Name-only matching is banned: a live probe proved it crosses fields."""
    a = repo.upsert_person(conn, Author(name="Jian Wang", idx=0, openalex_id="A1"))
    b = repo.upsert_person(conn, Author(name="Jian Wang", idx=0, openalex_id="A2"))
    assert a != b


def test_authorship_weights_follow_position(conn):
    authors = [
        Author(name="First A", idx=0, position="first", openalex_id="A1"),
        Author(name="Second B", idx=1, position="second", openalex_id="A2"),
        Author(name="Last C", idx=2, position="last", openalex_id="A3"),
    ]
    paper = make_paper(authors=authors)
    _, person_ids = repo.ingest_paper(conn, paper)
    weights = {
        r["person_id"]: r["position_weight"]
        for r in conn.execute("SELECT person_id, position_weight FROM authorships")
    }
    assert weights[person_ids[0]] == 1.0
    assert weights[person_ids[1]] == 0.8
    assert weights[person_ids[2]] == 0.8


def test_corresponding_author_outweighs_a_middle_slot():
    assert position_weight("middle", is_corresponding=True) == 1.0
    assert position_weight("middle") == 0.4


@pytest.mark.parametrize(
    "idx,total,expected",
    [(0, 5, "first"), (1, 5, "second"), (4, 5, "last"), (2, 5, "middle"), (0, 1, "first"), (1, 2, "last")],
)
def test_position_label(idx, total, expected):
    assert position_label(idx, total) == expected


def test_coauthor_edges_accumulate_across_papers(conn):
    a = Author(name="A", idx=0, openalex_id="A1")
    b = Author(name="B", idx=1, openalex_id="A2")
    repo.ingest_paper(conn, make_paper(doi="10.1/one", authors=[a, b], year=2020))
    repo.ingest_paper(conn, make_paper(doi="10.1/two", authors=[a, b], year=2024))

    edge = conn.execute("SELECT * FROM coauthor_edges").fetchone()
    assert edge["paper_count"] == 2
    assert edge["first_year"] == 2020
    assert edge["last_year"] == 2024


def test_coauthors_can_be_filtered_by_window(conn):
    a = Author(name="A", idx=0, openalex_id="A1")
    b = Author(name="B", idx=1, openalex_id="A2")
    repo.ingest_paper(conn, make_paper(doi="10.1/old", authors=[a, b], year=2010))
    person_a = repo.upsert_person(conn, a)

    assert repo.coauthors_of(conn, person_a, since_year=2021) == []
    assert len(repo.coauthors_of(conn, person_a)) == 1


def test_affiliation_and_country_round_trip(conn):
    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.store_institution_for(
        conn,
        person_id,
        name="University of Nottingham",
        ror_id="https://ror.org/01ee9ar58",
        country_code="GB",
        year_from=2020,
        is_current=True,
    )
    person = repo.load_person(conn, person_id)
    assert person is not None
    assert person.country_code == "GB"
    assert person.current_affiliation.institution == "University of Nottingham"


def test_education_without_a_source_url_is_refused(conn):
    from academia.core.models import Education, Institution

    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    inst = Institution.build(name="Some University")
    repo.upsert_institution(conn, inst)

    repo.record_education(
        conn, person_id, Education(inst_id=inst.inst_id, degree="PhD", source="homepage", source_url="")
    )
    assert conn.execute("SELECT count(*) FROM education").fetchone()[0] == 0

    repo.record_education(
        conn,
        person_id,
        Education(inst_id=inst.inst_id, degree="PhD", year_to=2015, source="orcid"),
    )
    assert conn.execute("SELECT count(*) FROM education").fetchone()[0] == 1


def test_phd_year_and_academic_age(conn):
    from academia.core.models import Education, Institution

    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    inst = Institution.build(name="Some University")
    repo.upsert_institution(conn, inst)
    repo.record_education(
        conn,
        person_id,
        Education(inst_id=inst.inst_id, degree="Ph.D.", year_to=2015, source="orcid"),
    )
    person = repo.load_person(conn, person_id)
    assert person.phd_year == 2015
    assert person.academic_age(2026) == 11


def test_email_keeps_the_highest_confidence_source(conn):
    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.record_email(conn, person_id, "a@uni.edu", source="lab_homepage", confidence=0.6)
    repo.record_email(conn, person_id, "a@uni.edu", source="published_corresponding", confidence=0.95)
    row = repo.emails_of(conn, person_id)[0]
    assert row["source"] == "published_corresponding"
    assert row["confidence"] == pytest.approx(0.95)


def test_run_artifacts_are_scoped_to_a_run(conn):
    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.create_manuscript(conn, ms_id="ms1", journal="TIE", title_hash="abc", origin_countries=["CN"])
    repo.create_run(conn, run_id="run1", ms_id="ms1")
    repo.record_score(conn, "run1", person_id, 0.87, {"topic": 0.9})
    repo.record_coi(conn, "run1", person_id, rule="recent_coauthor", status="BLOCK", evidence={"year": 2024})

    verdicts = repo.coi_for(conn, "run1", person_id)
    assert len(verdicts) == 1 and verdicts[0]["status"] == "BLOCK"


def test_manuscript_stores_no_title_text(conn):
    """Confidentiality: only a hash and the origin countries are persisted."""
    repo.create_manuscript(conn, ms_id="ms1", journal="TIE", title_hash="deadbeef", origin_countries=["CN"])
    row = conn.execute("SELECT * FROM manuscripts").fetchone()
    assert set(row.keys()) == {"ms_id", "journal", "title_hash", "origin_countries", "created_at"}
    assert row["title_hash"] == "deadbeef"


def test_invitation_history_survives_across_manuscripts(conn):
    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.record_invitation(conn, person_id, "ms1", responded=False)
    repo.record_invitation(conn, person_id, "ms2", responded=True, accepted=True)
    history = repo.invitation_history(conn, person_id)
    assert len(history) == 2


def test_current_employer_prefers_a_university_over_a_funder(conn):
    """OpenAlex marks several institutions current for a prolific author.

    A live run put "Education Department of Fujian Province" in the column an
    editor reads as employer, ahead of the university the person works at.
    """

    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    for name, kind, country in (
        ("Education Department of Fujian Province", "government", "CN"),
        ("Jiangsu University", "education", "CN"),
    ):
        repo.store_institution_for(
            conn, person_id, name=name, country_code=country,
            year_from=2020, year_to=2026, is_current=True, kind=kind,
        )

    person = repo.load_person(conn, person_id)
    assert person.current_affiliation.institution == "Jiangsu University"


def test_current_employer_falls_back_to_the_most_recent_when_none_is_flagged(conn):

    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.store_institution_for(
        conn, person_id, name="Old University", country_code="GB",
        year_from=2005, year_to=2010, is_current=False, kind="education",
    )
    repo.store_institution_for(
        conn, person_id, name="New University", country_code="GB",
        year_from=2015, year_to=2024, is_current=False, kind="education",
    )
    person = repo.load_person(conn, person_id)
    assert person.current_affiliation.institution == "New University"


def test_between_two_current_universities_the_longer_tenure_wins(conn):
    """The primary employer is the long-running one, not the newest addition."""
    person_id = repo.upsert_person(conn, Author(name="A", idx=0, openalex_id="A1"))
    repo.store_institution_for(
        conn, person_id, name="Recent Collaboration University", country_code="CN",
        year_from=2023, year_to=2026, is_current=True, kind="education",
    )
    repo.store_institution_for(
        conn, person_id, name="Home University", country_code="CN",
        year_from=2005, year_to=2026, is_current=True, kind="education",
    )
    person = repo.load_person(conn, person_id)
    assert person.current_affiliation.institution == "Home University"


# ------------------------------------------------- relevance term fallback


def test_relevance_matches_papers_that_share_words_but_not_the_whole_phrase(tmp_path):
    """A coined multi-word topic must not shrink the candidate pool.

    Author keywords arrive as phrases ("temporal-order migration") that appear
    verbatim in one paper on earth — the submission's own. Matching only those
    phrases left a live run scoring 46 of 476 stored papers, which makes every
    later stage arbitrary. Words are matched alongside phrases; BM25 still
    prefers the paper that has them together.
    """
    from academia.reviewer import discover
    from academia.reviewer.profile import Profile

    conn = db.connect(tmp_path / "r.db")
    try:
        repo.ingest_paper(
            conn,
            Paper(
                paper_id="phrase",
                source="openalex",
                title="Electromagnetic force order analysis",
                abstract="Order decomposition of electromagnetic force in machines.",
                year=2024,
            ),
        )
        repo.ingest_paper(
            conn,
            Paper(
                paper_id="words",
                source="openalex",
                title="Acoustic noise of traction machines",
                abstract="Noise measurements, with no force order analysis at all.",
                year=2024,
            ),
        )
        profile = Profile(
            manuscript_id="ms-1",
            title_hash="h",
            journal="tte",
            year=2026,
            primary_topics=["electromagnetic force order", "temporal-order migration"],
        )
        scores = discover.relevance(conn, profile, now_year=2026, limit=50)
        assert set(scores) == {"phrase", "words"}
        assert scores["phrase"] > scores["words"]
    finally:
        conn.close()


def test_person_topics_replace_rather_than_accumulate(conn):
    """Re-enriching must not leave last run's topics attached.

    An append-only write means a person whose OpenAlex labels change keeps the
    old ones forever. Because the topic score rewards covering the manuscript's
    vocabulary, accumulated stale terms inflate a candidate's score on every
    later run, with nothing in the report to show why.
    """
    person_id = repo.upsert_person(conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097"))
    repo.set_person_topics(conn, person_id, ["axial flux", "acoustic noise"], source="openalex")
    repo.set_person_topics(conn, person_id, ["marine biology"], source="openalex")

    assert repo.person_topics(conn, person_id) == ["marine biology"]


def test_person_topics_from_one_source_do_not_clear_another(conn):
    person_id = repo.upsert_person(conn, Author(name="Bo Second", idx=0, orcid="0000-0002-1825-0098"))
    repo.set_person_topics(conn, person_id, ["axial flux"], source="openalex")
    repo.set_person_topics(conn, person_id, ["vibration"], source="orcid")

    assert repo.person_topics(conn, person_id) == ["axial flux", "vibration"]


def test_person_topics_survive_a_reload(conn):
    """Topics must outlive the enrich process that fetched them.

    `coi` and `report` run as separate commands and reload every candidate from
    the store. While topics lived only on the in-memory Person, both the topic
    and method score components read empty and scored 0.00 for every candidate
    in a live run — a third of the ranking weight, silently inert.
    """
    person_id = repo.upsert_person(conn, Author(name="Ada Researcher", idx=0, orcid="0000-0002-1825-0097"))
    repo.set_person_topics(conn, person_id, ["axial flux machine", "acoustic noise"], source="openalex")

    reloaded = repo.load_person(conn, person_id)
    assert reloaded is not None
    assert reloaded.topics == ["acoustic noise", "axial flux machine"]


# ------------------------------------------------- FTS5 match expression


def test_match_expression_survives_hostile_topic_text(tmp_path):
    """Topic text comes from the submission's own keyword line.

    An unbalanced double quote makes an unterminated FTS5 phrase; _bm25_scores
    catches the OperationalError and returns nothing, so a malformed keyword
    silently empties the candidate pool. A crafted one could instead widen the
    match to every stored paper and let a submitting author steer which
    reviewers surface. The expression must stay valid and stay scoped whatever
    the keyword line contains.
    """
    from academia.reviewer.discover import _match_expression

    conn = db.connect(tmp_path / "hostile.db")
    try:
        repo.ingest_paper(
            conn,
            Paper(paper_id="p1", source="openalex", title="Axial flux machines", year=2024),
        )
        repo.ingest_paper(
            conn,
            Paper(paper_id="p2", source="openalex", title="Unrelated marine biology", year=2024),
        )
        expression = _match_expression(['3" pipe" OR machine OR "', "axial flux"])
        assert '"' not in expression.replace('""', "").strip('"').replace('" OR "', "")
        # Executes, and does not turn into a match-everything expression.
        found = {row["paper_id"] for row in repo.search_papers(conn, expression, limit=10)}
        assert found == {"p1"}
    finally:
        conn.close()


def test_match_expression_skips_topics_with_no_searchable_words():
    from academia.reviewer.discover import _match_expression

    assert _match_expression(["a an the"]) == ""
    assert _match_expression([""]) == ""


def test_match_expression_does_not_repeat_a_single_word_topic():
    from academia.reviewer.discover import _match_expression

    assert _match_expression(["magnet"]) == '"magnet"'


def test_bm25_reports_a_broken_expression_rather_than_returning_nothing(tmp_path, caplog):
    """A silently empty pool reads to an editor as 'no reviewers exist'."""

    conn = db.connect(tmp_path / "b.db")
    try:
        repo.ingest_paper(
            conn,
            Paper(paper_id="p1", source="openalex", title="Axial flux machines", year=2024),
        )
        with pytest.raises(sqlite3.OperationalError):
            repo.search_papers(conn, 'unbalanced "', limit=10)
    finally:
        conn.close()
