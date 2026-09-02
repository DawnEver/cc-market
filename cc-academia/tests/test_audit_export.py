"""The audit CSV: the file that answers "why is this person not on the list?".

Every column has to come from a rule that ran on this run. A heading naming a
threshold nobody applied, or a blank cell that reads like a rule found nothing
wrong, would make the file worse than no file: it would look like evidence.
"""

from __future__ import annotations

import csv
import io

import pytest

from academia.core.models import Education, Person
from academia.reviewer import eligibility, report
from academia.reviewer.enrich import EmailFinding
from academia.reviewer.policy import load_policy
from academia.reviewer.rank import Candidate, Evidence


def read(text: str) -> tuple[list[str], list[dict[str, str]]]:
    rows = list(csv.DictReader(io.StringIO(text)))
    return (list(rows[0]) if rows else []), rows


def candidate(person_id="p1", name="Candidate One", **kwargs) -> Candidate:
    return Candidate(person=Person(person_id=person_id, display_name=name), **kwargs)


def row(cand: Candidate, rank: int = 1, email: str = "a@b.edu") -> report.Row:
    return report.Row(
        rank=rank, candidate=cand, email=EmailFinding(email=email, source="test")
    )


def paper(venue_type: str, *, position: str = "first", year: int = 2025) -> Evidence:
    return Evidence(
        paper_id=f"paper-{venue_type}-{position}-{year}",
        title="A paper",
        year=year,
        position=position,
        position_weight=1.0,
        similarity=0.5,
        venue_type=venue_type,
    )


def test_a_rule_that_ran_contributes_its_verdict_and_its_numbers():
    cand = candidate()
    cand.eligibility = eligibility.Assessment(
        outcomes=[
            eligibility.assess_related_journals(
                [paper("Journal"), paper("Journal"), paper("Conference")],
                load_policy("tte").related_journals,
            )
        ]
    )

    header, rows = read(report.render_audit([row(cand)]))

    assert "filter_related_journal_publications" in header
    assert rows[0]["filter_related_journal_publications"] == "FILTERED"
    assert rows[0]["filter_related_journal_count"] == "2"
    assert rows[0]["filter_related_journal_minimum"] == "3"
    assert rows[0]["filter_related_journal_gap"] == "-1"
    # Author position is audited, never part of the rule.
    assert rows[0]["filter_related_first_author_count"] == "3"


def test_a_rule_that_was_switched_off_leaves_no_column():
    cand = candidate()
    cand.eligibility = eligibility.Assessment(
        outcomes=[eligibility.assess_related_journals([], load_policy().related_journals)]
    )

    header, _ = read(report.render_audit([row(cand)]))

    assert not [name for name in header if name.startswith("filter_related")]


def test_an_abstention_reads_as_verify_rather_than_as_a_pass():
    """No invitation history is not a good record; it is no record."""
    outcome = eligibility.RuleOutcome(
        "invitation_response", True, "0 invitation(s) — too few to judge", abstained=True
    )
    assert eligibility.verdict_of(outcome) == "VERIFY"

    cand = candidate()
    cand.eligibility = eligibility.Assessment(outcomes=[outcome])
    _, rows = read(report.render_audit([row(cand)]))
    assert rows[0]["filter_invitation_response"] == "VERIFY"


def test_a_preference_that_was_missed_is_not_a_failure():
    outcome = eligibility.RuleOutcome("recent_activity", False, "quiet lately", excluding=False)
    assert eligibility.verdict_of(outcome) == "PREFERENCE_MISSED"


def test_the_person_id_never_reaches_the_sheet():
    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    header, _ = read(report.render_audit([row(cand)]))
    assert "person_id" not in header


def test_academic_age_reports_both_ways():
    """The rule that only ever spoke when it had a complaint."""
    policy = load_policy()
    senior = Person(person_id="p-senior", display_name="Senior")
    senior.education.append(
        Education(inst_id="i1", institution="Somewhere", degree="PhD", year_to=2010)
    )
    outcome = eligibility.assess_academic_age(senior, policy, 2026)
    assert outcome.passed
    assert outcome.facts["academic_age_value"] == 16

    unknown = Person(person_id="p-unknown", display_name="Unknown")
    outcome = eligibility.assess_academic_age(unknown, policy, 2026)
    assert eligibility.verdict_of(outcome) == "VERIFY"
    assert outcome.facts["academic_age_known"] == 0


def test_the_conflict_verdict_and_its_severity_are_stated():
    from academia.reviewer import coi

    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    cand.verdict = coi.Verdict(person_id="p1")
    cand.verdict.add(coi.Finding("manuscript_author", coi.BLOCK, {"matched_by": "name"}))

    _, rows = read(report.render_audit([row(cand)]))
    assert rows[0]["filter_coi"] == "FILTERED"
    assert rows[0]["filter_coi_severity"] == "2"
    assert rows[0]["recommendation"] == "do_not_invite"


@pytest.mark.parametrize("found", [True, False])
def test_a_missing_address_leaves_the_cell_empty_rather_than_guessing(found):
    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    _, rows = read(report.render_audit([row(cand, email="a@b.edu" if found else "")]))
    assert rows[0]["email"] == ("a@b.edu" if found else "")


def test_the_recommendation_column_keeps_all_three_states():
    """"Meets every rule, address unverified" is not a rejection."""
    assert set(report.RECOMMENDATION.values()) == {
        "recommend",
        "check_first",
        "do_not_invite",
    }
