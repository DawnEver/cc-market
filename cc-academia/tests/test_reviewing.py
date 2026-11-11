"""Reviewing signals: what the tool states about a candidate as a reviewer.

Generic signals come from public sources on every run; Locator columns exist
only where an editorial page was imported. Unknown is always blank, never 0.
"""

from __future__ import annotations

from datetime import date

import pytest

from academia.core.models import Affiliation, Author
from academia.reviewer import reviewing
from academia.reviewer.policy import load_policy
from academia.reviewer.rank import Candidate, Evidence
from academia.store import db
from academia.store import repository as repo

TODAY = date(2026, 11, 11)


@pytest.fixture()
def conn(tmp_path):
    with db.session(tmp_path / "store.db") as connection:
        yield connection


@pytest.fixture()
def policy():
    return load_policy("tec")


def _candidate(conn, name="Erin Imaginary", orcid="0000-0000-0000-0001", evidence=()):
    pid = repo.upsert_person(conn, Author(name=name, idx=0, orcid=orcid))
    return Candidate(person=repo.load_person(conn, pid), evidence=list(evidence))


def _reviews(conn, person_id, items):
    repo.set_review_record(
        conn,
        person_id,
        [
            {"review_key": i, "group_id": g, "journal": j, "completed": d}
            for i, (g, j, d) in enumerate(items)
        ],
        source="orcid",
        source_url="https://orcid.org/x",
    )


def test_unknown_is_blank_not_zero(conn, policy):
    candidate = _candidate(conn, orcid="")
    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=True)
    assert out["reviews"] == ""
    assert out["reviews_source"] == "unknown"
    assert out["reviews_by_journal"] == ""
    assert out["reviewed_target_journal"] == ""
    assert out["articles_window"] == ""
    assert out["review_record"] == "VERIFY"
    assert out["found_by"] == "ours"
    assert out["invitation_status"] == "not yet invited"


def test_public_record_counts_and_target_journal(conn, policy):
    ev = Evidence("p1", "A Paper", 2025, "first", 1.0, 0.9, doi="10.1/x", venue="J")
    candidate = _candidate(conn, evidence=[ev])
    _reviews(
        conn,
        candidate.person.person_id,
        [
            ("issn:0885-8969", "IEEE Transactions on Energy Conversion", "2026-11-01"),
            ("issn:0885-8969", "IEEE Transactions on Energy Conversion", "2025-12"),
            ("issn:1234-5678", "Journal of Examples", "2019"),
        ],
    )
    repo.record_output(conn, candidate.person.person_id, {2026: 4, 2023: 3, 2015: 9}, source="openalex")
    candidate.person = repo.load_person(conn, candidate.person.person_id)

    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=True)
    assert out["found_by"] == "ours"
    assert out["reviews"] == 3
    assert out["reviews_source"] == "orcid"
    assert out["reviews_by_journal"] == (
        "IEEE Transactions on Energy Conversion 2; Journal of Examples 1"
    )
    assert out["reviewed_target_journal"] is True
    assert out["reviews_last_12_months"] == 2
    assert out["days_since_last_review"] == 10
    assert out["articles_window"] == 7
    assert out["relevant_works"].startswith("A Paper — J, 2025 — https://doi.org/10.1/x")
    assert out["orcid_url"] == "https://orcid.org/0000-0000-0000-0001"


def test_checked_but_empty_record_reads_zero_public(conn, policy):
    candidate = _candidate(conn)
    _reviews(conn, candidate.person.person_id, [])
    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=True)
    assert out["reviews"] == 0
    assert out["reviewed_target_journal"] is False
    assert out["days_since_last_review"] == ""


def test_invitation_load_and_status(conn, policy):
    candidate = _candidate(conn)
    pid = candidate.person.person_id
    repo.record_invitation(conn, pid, "ms-old", invited_at="2026-03-01", responded=None)
    repo.record_invitation(conn, pid, "ms-1", invited_at="2026-10-01", responded=True, accepted=False)
    repo.record_invitation(conn, pid, "ms-ancient", invited_at="2020-01-01", responded=True)
    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=True)
    assert out["invitation_status"] == "declined"
    assert out["invitations_last_12_months"] == 2
    assert out["invitations_open"] == 1


def test_returned_review_status_comes_from_the_editorial_import(conn, policy):
    candidate = _candidate(conn)
    pid = candidate.person.person_id
    repo.record_invitation(conn, pid, "ms-1", invited_at="2026-10-01", responded=True, accepted=True)
    assert reviewing.invitation_status(conn, pid, "ms-1") == "agreed"
    repo.replace_editorial_invitations(
        conn,
        "ms-1",
        [{"person_id": pid, "position": 1, "match_method": "orcid",
          "data": {"status": "Revise and Resubmit", "returned": "2026-10-28"}}],
    )
    assert reviewing.invitation_status(conn, pid, "ms-1") == "returned"


def test_suspicious_record_is_a_hint_only(conn, policy):
    candidate = _candidate(conn)
    pid = candidate.person.person_id
    _reviews(conn, pid, [("issn:1", "J", "2026-01-01")] * 1)
    repo.record_email(conn, pid, "someone@gmail.com", source="reviewer_locator")
    repo.replace_locator_suggestions(
        conn,
        "ms-1",
        [{"person_id": pid, "position": 1, "match_method": "orcid",
          "data": {"verified_reviews": 117, "articles": 20, "reviews_by_journal": [["IEEE Access", 37]],
                   "works": [], "current_assignments": 0, "past_year_assignments": 2,
                   "days_since_last_review": 3, "r_score": 2.75, "affiliations": [],
                   "wos_url": "https://www.webofscience.com/wos/author/record/X"}}],
    )
    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=False)
    assert out["found_by"] == "locator"
    assert out["locator_reviews"] == 117
    assert out["locator_load"] == "0 / 2"
    assert out["locator_r_score"] == 2.75
    assert out["review_record"] == "REVIEW"
    assert "only a non-institutional address" in out["review_record_reasons"]
    assert out["review_record_reviews_minimum"] == 20


def test_many_countries_also_trip_the_hint(conn, policy):
    candidate = _candidate(conn)
    pid = candidate.person.person_id
    _reviews(conn, pid, [("issn:1", "J", "2026-01-01")] * 30)
    repo.record_output(conn, pid, {2025: 5}, source="openalex")
    repo.record_email(conn, pid, "x@uni.example.edu", source="institutional_profile")
    person = repo.load_person(conn, pid)
    person.affiliations = [
        Affiliation(inst_id=f"i{c}", institution=c, country_code=c, is_current=True)
        for c in ("AA", "BB", "CC")
    ]
    candidate.person = person
    out = reviewing.signals(conn, candidate, policy, ms_id="ms-1", today=TODAY, harvested=True)
    assert out["review_record"] == "REVIEW"
    assert "3 countries" in out["review_record_reasons"]
