"""Two rules an editor states rather than derives.

The restricted-country rule refuses whole countries; the related-journal rule
demands that the relevant record be journal work. Both can remove a qualified
person from a shortlist, so both are tested the way the other eligibility rules
are: they must fail in the direction of keeping somebody, and an absence of
evidence must never read as evidence.
"""

from __future__ import annotations

import re

import pytest

from academia.core.errors import UsageError
from academia.core.models import Affiliation, Person
from academia.reviewer import eligibility
from academia.reviewer import policy as policy_module
from academia.reviewer.policy import Policy, load_policy
from academia.store import db

NOW = 2026


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "restricted.db")
    yield connection
    connection.close()


def person_in(country: str, *, name: str = "Candidate") -> Person:
    person = Person(person_id=f"p-{name}", display_name=name)
    person.affiliations.append(
        Affiliation(
            inst_id="i1",
            institution="Some Uni",
            country_code=country,
            is_current=True,
            source="openalex",
        )
    )
    return person


def restricted(mode: str = "require", countries=("IN", "IR")) -> Policy:
    base = load_policy()
    geo = {**base.data["geo"], "restricted": {"mode": mode, "countries": list(countries)}}
    return Policy(data={**base.data, "geo": geo}, sources=base.sources, journal=base.journal)


def related(mode: str = "require", minimum: int = 3) -> Policy:
    base = load_policy()
    activity = {
        **base.data["activity"],
        "related_journals": {"mode": mode, "min_publications": minimum},
    }
    return Policy(data={**base.data, "activity": activity}, sources=base.sources, journal=base.journal)


# --------------------------------------------------------- restricted ----


def test_a_restricted_country_excludes_the_candidate(conn):
    assessment = eligibility.assess(conn, person_in("IN"), restricted(), now_year=NOW)

    assert assessment.excluded
    assert "does not invite from" in assessment.reason


def test_the_country_code_is_matched_case_insensitively(conn):
    assessment = eligibility.assess(conn, person_in("ir"), restricted(), now_year=NOW)

    assert assessment.excluded


def test_an_unrestricted_country_passes_without_a_note(conn):
    assessment = eligibility.assess(conn, person_in("CN"), restricted(), now_year=NOW)

    assert not assessment.excluded
    assert not any("restricted" in note for note in assessment.notes())


def test_an_unknown_country_is_kept_and_sent_for_confirmation(conn):
    assessment = eligibility.assess(conn, person_in(""), restricted(), now_year=NOW)

    assert not assessment.excluded
    outcome = next(o for o in assessment.outcomes if o.rule == "restricted_country")
    assert outcome.manual_review
    assert "IN, IR" in outcome.detail


def test_under_prefer_a_restricted_country_annotates_but_keeps(conn):
    assessment = eligibility.assess(conn, person_in("IN"), restricted("prefer"), now_year=NOW)

    assert not assessment.excluded
    assert any("does not invite from" in note for note in assessment.notes())


def test_a_switched_on_rule_with_no_countries_is_refused():
    # Silently passing everybody would be worse than refusing the policy.
    with pytest.raises(UsageError, match=re.escape("geo.restricted.countries is empty")):
        policy_module._validate_restricted_countries(restricted(countries=()))


def test_a_country_that_is_not_an_iso_code_is_refused():
    with pytest.raises(UsageError, match="two-letter ISO codes"):
        policy_module._validate_restricted_countries(restricted(countries=("India",)))


def test_an_off_rule_needs_no_countries():
    policy_module._validate_restricted_countries(restricted("off", countries=()))


def test_tte_does_not_invite_from_india_or_iran(conn):
    tte = load_policy("tte")

    assert tte.restricted_country.upper_set("countries") == {"IN", "IR"}
    assert eligibility.assess(conn, person_in("IN"), tte, now_year=NOW).excluded


# ---------------------------------------------------- related journals ----


def test_enough_journal_papers_passes():
    outcome = eligibility.assess_related_journals(
        ["Journal", "journal-article", "JournalArticle"], related().related_journals
    )

    assert outcome.passed
    assert "3 relevant journal publication(s)" in outcome.detail


def test_conference_papers_do_not_count_towards_the_floor():
    outcome = eligibility.assess_related_journals(
        ["Journal", "Conference", "Conference"], related().related_journals
    )

    assert outcome.excluded
    assert "only 1 relevant journal publication(s) of 3" in outcome.detail


def test_an_unresolved_venue_is_reported_rather_than_counted_against_anyone():
    outcome = eligibility.assess_related_journals(
        ["Journal", "Journal", ""], related().related_journals
    )

    assert not outcome.excluded
    assert outcome.manual_review
    assert "unstated venue type" in outcome.detail


def test_unresolved_venues_that_could_not_reach_the_floor_still_fail():
    outcome = eligibility.assess_related_journals(["Conference", ""], related().related_journals)

    assert outcome.excluded
    assert not outcome.manual_review


def test_under_prefer_a_thin_journal_record_annotates_but_keeps():
    outcome = eligibility.assess_related_journals(["Conference"], related("prefer").related_journals)

    assert not outcome.passed
    assert not outcome.excluded


def test_the_rule_is_off_by_default():
    outcome = eligibility.assess_related_journals([], load_policy().related_journals)

    assert outcome.passed
    assert outcome.detail == "not assessed"


def test_tte_requires_three_related_journal_papers():
    constraint = load_policy("tte").related_journals

    assert constraint.excluding
    assert eligibility.assess_related_journals(["Journal"] * 3, constraint).passed
    assert eligibility.assess_related_journals(["Journal"] * 2, constraint).excluded
