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
from academia.reviewer.record import CandidateRecord, RelevantRecord


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


def journal_outcome(papers, journal="tte"):
    record = CandidateRecord(
        person=Person(person_id="p1", display_name="Candidate One"),
        now_year=2026,
        relevant=RelevantRecord(tuple(papers)),
    )
    return eligibility.related_journals(
        record, load_policy(journal).constraint("related_journals")
    )


def test_a_rule_that_ran_contributes_its_verdict_and_its_numbers():
    cand = candidate()
    cand.eligibility = eligibility.Assessment(
        outcomes=[journal_outcome([paper("Journal"), paper("Journal"), paper("Conference")])]
    )

    header, rows = read(report.render_audit([row(cand)], load_policy()))

    # Every column a rule produces is named after that rule, which is what lets
    # a workbook group them without a hand-kept table of prefixes.
    assert "filter_related_journals" in header
    assert rows[0]["filter_related_journals"] == "FILTERED"
    assert rows[0]["filter_related_journals_count"] == "2"
    assert rows[0]["filter_related_journals_minimum"] == "3"
    # Author position is audited, never part of the rule.
    assert rows[0]["filter_related_journals_first_author"] == "3"


def test_a_rule_that_was_switched_off_leaves_no_column():
    """A switched-off rule contributes no outcome at all, so no column either.

    It used to answer ``off`` from inside the rule with a "not assessed"
    outcome that the exporter then had to recognise by its prose. Now the loop
    that runs the rules skips it, and there is nothing to recognise.
    """
    cand = candidate()
    cand.eligibility = eligibility.assess(
        CandidateRecord(person=cand.person, now_year=2026), load_policy()
    )

    header, _ = read(report.render_audit([row(cand)], load_policy()))

    assert not [name for name in header if name.startswith("filter_related")]


def test_an_abstention_reads_as_verify_rather_than_as_a_pass():
    """No invitation history is not a good record; it is no record."""
    outcome = eligibility.RuleOutcome(
        "invitation_response", True, "0 invitation(s) — too few to judge", abstained=True
    )
    assert eligibility.verdict_of(outcome) == "VERIFY"

    cand = candidate()
    cand.eligibility = eligibility.Assessment(outcomes=[outcome])
    _, rows = read(report.render_audit([row(cand)], load_policy()))
    assert rows[0]["filter_invitation_response"] == "VERIFY"


def test_a_preference_that_was_missed_is_not_a_failure():
    outcome = eligibility.RuleOutcome("recent_activity", False, "quiet lately", excluding=False)
    assert eligibility.verdict_of(outcome) == "PREFERENCE_MISSED"


def test_the_person_id_never_reaches_the_sheet():
    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    header, _ = read(report.render_audit([row(cand)], load_policy()))
    assert "person_id" not in header


def test_seniority_reports_the_figure_and_what_it_counted_from():
    """One axis, and the basis is stated because the two bases differ.

    This was two rules — a floor in years since the doctorate and a ceiling in
    years of publishing — and when a doctorate year was known they measured the
    same quantity from different sources. A reader could not tell which figure
    a column held.
    """
    constraint = load_policy().constraint("seniority")

    senior = Person(person_id="p-senior", display_name="Senior")
    senior.education.append(
        Education(inst_id="i1", institution="Somewhere", degree="PhD", year_to=2010)
    )
    outcome = eligibility.seniority(
        CandidateRecord(person=senior, now_year=2026), constraint
    )
    assert outcome.passed
    assert outcome.facts["seniority_years"] == 16
    assert outcome.facts["seniority_basis"] == "doctorate"

    unknown = Person(person_id="p-unknown", display_name="Unknown")
    outcome = eligibility.seniority(
        CandidateRecord(person=unknown, now_year=2026), constraint
    )
    assert eligibility.verdict_of(outcome) == "VERIFY"
    assert "seniority_years" not in outcome.facts


def test_the_conflict_verdict_and_its_severity_are_stated():
    from academia.reviewer import coi

    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    cand.verdict = coi.Verdict(person_id="p1")
    cand.verdict.add(coi.Finding("manuscript_author", coi.BLOCK, {"matched_by": "name"}))

    _, rows = read(report.render_audit([row(cand)], load_policy()))
    assert rows[0]["filter_coi"] == "BLOCK"
    assert rows[0]["filter_coi_severity"] == "2"
    assert rows[0]["recommendation"] == "do_not_invite"


@pytest.mark.parametrize("found", [True, False])
def test_a_missing_address_leaves_the_cell_empty_rather_than_guessing(found):
    cand = candidate()
    cand.eligibility = eligibility.Assessment()
    _, rows = read(report.render_audit([row(cand, email="a@b.edu" if found else "")], load_policy()))
    assert rows[0]["email"] == ("a@b.edu" if found else "")


def test_the_recommendation_column_keeps_all_three_states():
    """"Meets every rule, address unverified" is not a rejection."""
    assert set(report.RECOMMENDATION.values()) == {
        "recommend",
        "check_first",
        "do_not_invite",
    }
