"""The store is the part that has to survive being run twice."""

from __future__ import annotations

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
