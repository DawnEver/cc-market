"""Reading a ScholarOne "Assign Reviewers" page.

The fixture is synthetic: the structure of a saved page, with every name,
address, identifier and title invented. A real page holds a confidential
manuscript and real people's addresses and never enters this repository.
"""

from __future__ import annotations

import pytest

from academia.referee import scholarone
from conftest import FIXTURE_DIR


@pytest.fixture(scope="module")
def page() -> scholarone.AssignPage:
    return scholarone.parse(
        (FIXTURE_DIR / "scholarone_assign_reviewers.html").read_text(encoding="utf-8")
    )


def test_header(page):
    assert page.manuscript_ref == "XMP-00001-2026"
    assert page.submitted == "2026-08-25"
    assert page.last_updated == "2026-10-17"
    assert page.summary == {
        "active selections": 2,
        "invited": 4,
        "agreed": 2,
        "declined": 1,
        "returned": 1,
    }


def test_reviewer_list(page):
    names = [i.name for i in page.invitees]
    assert names == ["Example, Ada", "Sample, Bruno", "Placeholder, Chen", "Fictional, Dana"]
    pending, declined, returned, agreed = page.invitees

    assert pending.status == "Invited"
    assert pending.invited == "2026-10-01"
    assert (pending.responded, pending.accepted) == (None, None)

    assert declined.status == "Declined"
    assert declined.orcid == "0000-0000-0000-0002"
    assert declined.affiliation == "Example Institute of Technology"
    assert declined.declined == "2026-10-02"
    assert (declined.responded, declined.accepted) == (True, False)

    assert returned.status == "Revise and Resubmit"
    assert returned.agreed == "2026-10-01"
    assert returned.due == "2026-10-29"
    assert returned.returned == "2026-10-28"
    assert returned.days_in_review == 27
    assert returned.decision_letter == 1
    assert (returned.responded, returned.accepted) == (True, True)

    assert agreed.status == "Agreed"
    assert agreed.due == "2026-11-01"
    assert agreed.returned == ""
    assert (agreed.responded, agreed.accepted) == (True, True)


def test_locator_suggestions(page):
    assert page.locator_total == 7
    assert [s.name for s in page.suggestions] == [
        "Erin Imaginary",
        "Frank Madeup",
        "Chen Placeholder",
    ]
    erin, frank, chen = page.suggestions

    assert erin.wos_url == "https://www.webofscience.com/wos/author/record/AAA-0001-2020"
    assert erin.wos_id == "AAA-0001-2020"
    assert erin.orcid == "0000-0000-0000-0001"
    assert erin.emails == ("erin.imaginary@gmail.com",)
    assert erin.affiliations == (
        ("Example Polytechnic", "IS"),
        ("Second Example University", "IS"),
    )
    assert erin.verified_reviews == 80
    assert erin.reviews_by_journal == (
        ("Journal of Examples", 40),
        ("IEEE Transactions on Energy Conversion", 3),
        ("IEEE Access", 37),
    )
    assert erin.articles == 20
    assert (erin.current_assignments, erin.past_year_assignments) == (0, 2)
    assert erin.days_since_last_review == 3
    assert erin.r_score == pytest.approx(2.75)
    first, second = erin.works
    assert first.title == "Synthetic Flux Machines for Testing"
    assert first.authors == "Erin Imaginary;F. Other;et al."
    assert (first.venue, first.year) == ("Energies", 2022)
    assert first.doi == "10.0000/test.0001"
    assert second.venue == "Ieee Transactions on Energy Conversion"

    # An institution name with a comma in it stays one institution; the
    # country is what ends it.
    assert frank.affiliations == (("University of Example, Department of Tests", "GB"),)
    assert frank.orcid == ""

    # WoS writes some countries in mixed case.
    assert chen.affiliations == (("University of Example", "CN"),)
    assert chen.verified_reviews == 0
    assert chen.reviews_by_journal == ()
    assert chen.works == ()
    assert chen.days_since_last_review is None
    assert chen.r_score is None


def test_country_codes():
    assert scholarone.country_code("ENGLAND") == "GB"
    assert scholarone.country_code("Peoples R China") == "CN"
    assert scholarone.country_code("U ARAB EMIRATES") == "AE"
    assert scholarone.country_code("Atlantis") == ""


def test_affiliation_line_with_known_countries():
    emails, places = scholarone.split_contact_line(
        "a@example.org; Inst One, Town, INDIA, SAIEE, SOUTH AFRICA, Trailing Inst"
    )
    assert emails == ("a@example.org",)
    assert places == (
        ("Inst One, Town", "IN"),
        ("SAIEE", "ZA"),
        ("Trailing Inst", ""),
    )


def test_page_without_sections_is_refused():
    with pytest.raises(scholarone.NotAnAssignPage):
        scholarone.parse("<html><body>Nothing here</body></html>")


# ------------------------------------------------------------------ storing


@pytest.fixture()
def conn(tmp_path):
    from academia.store import db

    with db.session(tmp_path / "store.db") as connection:
        yield connection


def _harvested(conn, name, **ids):
    from academia.core.models import Author
    from academia.store import repository as repo

    return repo.upsert_person(conn, Author(name=name, idx=0, **ids))


def test_import_matches_by_orcid_then_email_then_name(conn, page):
    from academia.store import repository as repo

    erin = _harvested(conn, "E. Imaginary", orcid="0000-0000-0000-0001")
    frank = _harvested(conn, "Frank M.", openalex_id="A-frank")
    repo.record_email(conn, frank, "f.madeup@example.org", source="orcid_public")
    chen = _harvested(conn, "Chen Placeholder", openalex_id="A-chen")
    rows = [{"person_id": pid} for pid in (erin, frank, chen)]

    result = scholarone.store_page(conn, page, "ms-1", candidate_rows=rows)

    methods = {
        row["person_id"]: row["match_method"] for row in repo.locator_suggestions(conn, "ms-1")
    }
    assert methods == {erin: "orcid", frank: "email", chen: "name"}
    assert result.locator == {"orcid": 1, "email": 1, "name": 1}

    invited = {row["person_id"]: row for row in repo.editorial_invitations(conn, "ms-1")}
    assert chen in invited and invited[chen]["match_method"] == "name"
    assert len(invited) == 4
    history = {r["person_id"]: r for r in conn.execute("SELECT * FROM review_history")}
    assert (history[chen]["responded"], history[chen]["accepted"]) == (1, 1)
    assert all(r["ms_id"] == "ms-1" for r in history.values())


def test_a_name_never_matches_outside_this_runs_candidates(conn, page):
    from academia.store import repository as repo

    stranger = _harvested(conn, "Frank Madeup", openalex_id="A-other-frank")
    scholarone.store_page(conn, page, "ms-1", candidate_rows=[])
    frank = next(
        r for r in repo.locator_suggestions(conn, "ms-1") if r["data"]["name"] == "Frank Madeup"
    )
    assert frank["person_id"] != stranger
    assert frank["match_method"] == "new"


def test_locator_people_join_the_candidate_pool_without_evidence(conn, page):
    ours = _harvested(conn, "E. Imaginary", orcid="0000-0000-0000-0001")
    rows = [{"person_id": ours, "evidence": [{"paper_id": "p"}], "relevant_papers": []}]
    scholarone.store_page(conn, page, "ms-1", candidate_rows=rows)

    merged = scholarone.merge_candidates(conn, rows, "ms-1")
    assert merged[0] is rows[0]
    added = merged[1:]
    assert len(added) == 2
    assert all(row["evidence"] == [] and row["relevant_papers"] == [] for row in added)
    assert not any(row["harvested"] for row in added)
    # Merging twice adds nobody twice.
    assert scholarone.merge_candidates(conn, merged, "ms-1") == merged


def test_import_is_idempotent(conn, page):
    from academia.store import repository as repo

    scholarone.store_page(conn, page, "ms-1", candidate_rows=[])
    scholarone.store_page(conn, page, "ms-1", candidate_rows=[])
    assert len(repo.locator_suggestions(conn, "ms-1")) == 3
    assert conn.execute("SELECT count(*) FROM review_history").fetchone()[0] == 4
    summary = repo.editorial_import(conn, "ms-1")
    assert summary["summary"]["invited"] == 4
    assert summary["locator_total"] == 7


def test_manuscript_rows_refuse_an_undeclared_table(conn):
    """Table names are a closed set of literal statements, never interpolated SQL."""
    from academia.store import repository as repo

    with pytest.raises(ValueError, match="no manuscript-row table"):
        repo._replace_ms_rows(conn, "people; DROP TABLE people", "ms-1", [])


def test_manuscript_rows_read_refuses_an_undeclared_table(conn):
    from academia.store import repository as repo

    with pytest.raises(ValueError, match="no manuscript-row table"):
        repo._ms_rows(conn, "people", "ms-1")
