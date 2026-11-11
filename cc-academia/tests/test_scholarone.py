"""Reading a ScholarOne "Assign Reviewers" page.

The fixture is synthetic: the structure of a saved page, with every name,
address, identifier and title invented. A real page holds a confidential
manuscript and real people's addresses and never enters this repository.
"""

from __future__ import annotations

import pytest

from academia.reviewer import scholarone
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
