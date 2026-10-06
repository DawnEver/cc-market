"""The audit CSV: the file that answers "why is this person not on the list?".

Every column has to come from a rule that ran on this run. A heading naming a
threshold nobody applied, or a blank cell that reads like a rule found nothing
wrong, would make the file worse than no file: it would look like evidence.
"""

from __future__ import annotations

import csv
import io

import pytest

from academia.core.models import Affiliation, Education, Person
from academia.reviewer import eligibility, report
from academia.reviewer import rank as rank_module
from academia.reviewer.enrich import EmailFinding
from academia.reviewer.policy import Policy, load_policy
from academia.reviewer.rank import Candidate, Evidence
from academia.reviewer.record import CandidateRecord, RelevantRecord
from conftest import neutral


def read(text: str) -> tuple[list[str], list[dict[str, str]]]:
    rows = list(csv.DictReader(io.StringIO(text)))
    return (list(rows[0]) if rows else []), rows


def candidate(person_id="p1", name="Candidate One", **kwargs) -> Candidate:
    return Candidate(person=Person(person_id=person_id, display_name=name), **kwargs)


def row(cand: Candidate, rank: int = 1, email: str = "a@b.edu.example") -> report.Row:
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
    off = neutral(load_policy())
    cand = candidate()
    cand.eligibility = eligibility.assess(
        CandidateRecord(person=cand.person, now_year=2026), off
    )

    header, _ = read(report.render_audit([row(cand)], off))

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


def test_the_homepage_link_prefers_xplore_then_orcid():
    """The order an editor wants, for an IEEE submission.

    Xplore first: it is the page they already have open, it is maintained by the
    publisher being reviewed for, and it lists the work in that venue. ORCID
    next, then the publication profile. Each step only applies when the
    identifier above it is absent, so the link never regresses to a worse page
    while a better one is known.
    """
    def with_ids(**ids):
        return Candidate(person=Person(person_id="p1", display_name="Candidate One", **ids))

    assert report.profile_url(
        with_ids(ieee_author_id="37086766701", orcid="0000-0002-1825-0097", openalex_id="A123")
    ) == "https://ieeexplore.ieee.org/author/37086766701"

    assert report.profile_url(
        with_ids(orcid="0000-0002-1825-0097", openalex_id="A123")
    ) == "https://orcid.org/0000-0002-1825-0097"

    assert report.profile_url(with_ids(openalex_id="A123")) == "https://openalex.org/A123"

    # Nothing but a paper, which is what the work itself links to.
    assert report.profile_url(
        Candidate(person=Person(person_id="p1", display_name="Candidate One"),
                  evidence=[Evidence(paper_id="p", title="t", year=2024, position="first",
                                     position_weight=1.0, similarity=0.9, doi="10.1/x")])
    ) == "https://doi.org/10.1/x"


def coverage_row(index: int, *, blocked: bool, found: bool) -> report.Row:
    person = Person(
        person_id=f"p{index}", display_name=f"Candidate {index}",
        confidence=0.99, resolution_method="orcid",
    )
    person.affiliations.append(
        Affiliation(inst_id="i1", institution="Some Uni", country_code="GB",
                    is_current=True, source="orcid")
    )
    candidate = Candidate(person=person)
    # `blocked` is derived from the score, which is how the ranker marks a
    # candidate a conflict removed rather than merely ranked low.
    if blocked:
        candidate.score = rank_module.BLOCKED_SCORE
    return report.Row(
        rank=index,
        candidate=candidate,
        email=EmailFinding(email="a@uni.example" if found else ""),
    )


def test_coverage_holds_the_invitable_classes_to_the_higher_bar():
    """Two bars, because a missing address matters most where an invitation
    could still go out — and one pooled rate cannot say which name is missing."""
    rows = [
        *(coverage_row(i, blocked=False, found=i <= 9) for i in range(1, 11)),      # 9/10
        *(coverage_row(100 + i, blocked=True, found=i <= 6) for i in range(1, 11)),  # 6/10
    ]

    summary = report.email_coverage(rows, neutral(load_policy()))

    assert (summary["invitable"]["with_address"], summary["invitable"]["total"]) == (9, 10)
    assert summary["invitable"]["met"] is True
    assert (summary["other"]["with_address"], summary["other"]["total"]) == (6, 10)
    assert summary["other"]["met"] is True
    assert summary["met"] is True


def test_the_coverage_bars_are_policy_and_a_shortfall_is_reported_not_hidden():
    rows = [*(coverage_row(i, blocked=False, found=i <= 9) for i in range(1, 11))]

    base = load_policy()
    strict = Policy(
        data={**base.data, "coverage": {"invitable_email": 0.95, "other_email": 0.60}},
        sources=base.sources,
        journal=base.journal,
    )
    summary = report.email_coverage(rows, strict)

    assert summary["invitable"]["required"] == 0.95
    assert summary["invitable"]["met"] is False
    assert summary["met"] is False


def test_a_class_with_nobody_in_it_is_not_a_shortfall():
    """Nothing was missed, so a run with no invitable candidate still reports
    the coverage it was judged by rather than dividing by zero."""
    rows = [coverage_row(1, blocked=True, found=True)]

    summary = report.email_coverage(rows, neutral(load_policy()))

    assert summary["invitable"]["total"] == 0
    assert summary["invitable"]["rate"] == 1.0
    assert summary["met"] is True


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
    # The subject is the figure and its basis, so the band has to contain the
    # person: the shipped policy prefers a career under ten years, and this one
    # is sixteen.
    base = load_policy()
    constraint = Policy(
        data={**base.data, "seniority": {**base.data["seniority"], "max_years": 0}},
        sources=base.sources,
        journal=base.journal,
    ).constraint("seniority")

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
    _, rows = read(report.render_audit([row(cand, email="a@b.edu.example" if found else "")], load_policy()))
    assert rows[0]["email"] == ("a@b.edu.example" if found else "")


def test_the_recommendation_column_keeps_all_three_states():
    """"Meets every rule, address unverified" is not a rejection."""
    assert set(report.RECOMMENDATION.values()) == {
        "recommend",
        "check_first",
        "do_not_invite",
    }
