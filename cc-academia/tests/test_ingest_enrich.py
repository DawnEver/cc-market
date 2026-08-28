"""Front-matter parsing and enrichment, including the rules about what is refused."""

from __future__ import annotations

import pytest

from academia.core.models import Author, Person
from academia.ingest import pdf as ingest_pdf
from academia.reviewer import enrich
from academia.store import db
from academia.store import repository as repo

FIRST_PAGE = """
IEEE TRANSACTIONS ON INDUSTRIAL ELECTRONICS, VOL. 73, NO. 4, APRIL 2026

Torque Ripple Suppression in Permanent Magnet Synchronous Motor Drives

Grace Expert, Senior Member, IEEE, and Ravi Junior, Member, IEEE

Abstract—This paper proposes a torque ripple suppression scheme for
permanent magnet synchronous motor drives used in traction applications.
Experimental results confirm the reduction.

Index Terms—Torque ripple, permanent magnet machines, traction drives.

I. INTRODUCTION
Torque ripple degrades ride comfort in electric vehicles, and the body of the
paper continues from here for many pages.
"""


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "e.db")
    yield connection
    connection.close()


# ------------------------------------------------------------ front matter


def test_front_matter_extracts_title_abstract_and_keywords():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "Torque Ripple Suppression" in parsed["title"]
    assert parsed["abstract"].startswith("This paper proposes")
    assert "Torque ripple" in parsed["keywords"]


def test_front_matter_stops_the_abstract_before_the_introduction():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "INTRODUCTION" not in parsed["abstract"]
    assert "ride comfort" not in parsed["abstract"]


def test_front_matter_ignores_the_all_caps_running_head():
    parsed = ingest_pdf.parse_front_matter(FIRST_PAGE)
    assert "IEEE TRANSACTIONS" not in parsed["title"]


def test_front_matter_recovers_a_doi_when_present():
    parsed = ingest_pdf.parse_front_matter("Digital Object Identifier 10.1109/TIE.2026.1234567")
    assert parsed["doi"] == "10.1109/tie.2026.1234567"


def test_front_matter_returns_empty_rather_than_guessing():
    parsed = ingest_pdf.parse_front_matter("")
    assert parsed["title"] == ""
    assert parsed["abstract"] == ""


def test_decomposition_refuses_without_the_optional_extra(tmp_path, monkeypatch):
    """A half-decomposed directory reads as success to every later step."""
    from academia.core.errors import UsageError

    monkeypatch.setattr(ingest_pdf, "_has_ingest", lambda: False)
    with pytest.raises(UsageError):
        ingest_pdf.decompose(tmp_path / "x.pdf", tmp_path / "out")


# ------------------------------------------------------------------ email


def test_role_addresses_are_not_treated_as_personal():
    found = enrich.extract_emails("Contact info@uni.edu or grace.expert@uni.edu")
    assert "info@uni.edu" not in found
    assert "grace.expert@uni.edu" in found


def test_an_address_must_match_the_person_to_be_used():
    person = Person(person_id="p", display_name="Grace Expert")
    emails = ["someone.else@uni.edu", "g.expert@uni.edu"]
    assert enrich.match_email_to_person(emails, person) == "g.expert@uni.edu"


def test_an_unrelated_departmental_address_is_rejected():
    """Otherwise the invitation reaches whoever appeared first on the page."""
    person = Person(person_id="p", display_name="Grace Expert")
    assert enrich.match_email_to_person(["postgrad.office@uni.edu"], person) == ""


def test_no_address_is_ever_generated_from_a_pattern(conn):
    person = Person(person_id="p", display_name="Grace Expert")
    finding = enrich.find_email(conn, person)
    assert not finding.found
    assert finding.source == enrich.NOT_FOUND
    assert finding.email == ""


def test_a_found_address_records_where_it_came_from(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    person = repo.load_person(conn, person_id)

    pages = {"https://www.uni.ac.uk/people/grace": "Email: grace.expert@uni.ac.uk"}
    finding = enrich.find_email(
        conn, person, page_fetcher=pages.get, homepage_urls=list(pages)
    )
    assert finding.email == "grace.expert@uni.ac.uk"
    assert finding.source == "institutional_profile"
    assert finding.source_url.startswith("https://www.uni.ac.uk")
    assert finding.confidence >= 0.9

    stored = repo.emails_of(conn, person_id)
    assert stored[0]["source_url"] == finding.source_url


def test_a_blocked_page_is_skipped_rather_than_retried(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    person = repo.load_person(conn, person_id)

    attempts = []

    def fetcher(url):
        attempts.append(url)
        raise RuntimeError("403")

    finding = enrich.find_email(
        conn, person, page_fetcher=fetcher, homepage_urls=["https://blocked.example/"]
    )
    assert not finding.found
    assert attempts == ["https://blocked.example/"]


def test_a_stored_address_is_reused_without_fetching(conn):
    person_id = repo.upsert_person(conn, Author(name="Grace Expert", idx=0, openalex_id="A1"))
    repo.record_email(
        conn, person_id, "grace@uni.edu", source="published_corresponding",
        source_url="https://doi.org/10.1/x", confidence=0.95,
    )
    person = repo.load_person(conn, person_id)

    def explode(url):
        raise AssertionError("must not fetch when an address is already known")

    finding = enrich.find_email(conn, person, page_fetcher=explode, homepage_urls=["https://x/"])
    assert finding.email == "grace@uni.edu"
    assert finding.source == "published_corresponding"
