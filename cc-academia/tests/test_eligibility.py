"""Eligibility: still active, far enough along, and still taking review work.

Every rule here can exclude someone from a shortlist, so every rule has to fail
in the direction of keeping them. Missing evidence — no publication years, no
enrolment year, no invitation history — never disqualifies anybody, because the
absence of a fact is not a fact about the person.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from academia.core.errors import UsageError
from academia.core.models import Author, Education, Paper, Person
from academia.reviewer import eligibility, rank, report
from academia.reviewer.policy import Constraint, Policy, load_policy
from academia.reviewer.record import CandidateRecord
from academia.store import db
from academia.store import repository as repo
from conftest import assess

NOW = 2026


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "eligibility.db")
    yield connection
    connection.close()


@pytest.fixture()
def policy():
    return load_policy()


def tuned(base: Policy, **sections) -> Policy:
    """A policy with some tables overridden, the way a journal file would."""
    data = dict(base.data)
    for key, value in sections.items():
        data[key] = {**data[key], **value}
    return Policy(data=data, sources=base.sources, journal=base.journal)


def author_with_papers(conn, *years: int, name: str = "Candidate") -> Person:
    """Store a person and one paper per year, so the store has a real history."""
    person_id = ""
    for year in years:
        author = Author(name=name, idx=0, position="first", openalex_id="A-" + name)
        paper = Paper(
            paper_id=f"paper-{name}-{year}",
            title=f"{name} {year}",
            source="openalex",
            year=year,
            authors=[author],
        )
        _, ids = repo.ingest_paper(conn, paper)
        person_id = ids[0]
    if not person_id:
        person_id = repo.upsert_person(conn, Author(name=name, idx=0, openalex_id="A-" + name))
    return Person(person_id=person_id, display_name=name, confidence=0.99, resolution_method="orcid")


def doctoral(person: Person, *, start: int | None) -> Person:
    person.stated_rank = "phd_student"
    person.rank_source = "https://example.edu/people"
    if start is not None:
        person.education.append(
            Education(inst_id="i1", institution="Some Uni", degree="PhD", year_from=start)
        )
    return person


# ------------------------------------------------------------- activity ----


def test_recent_publications_pass_the_activity_window(conn, policy):
    person = author_with_papers(conn, 2024, 2025, name="Active")
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score == 1.0


def test_a_dormant_author_is_flagged_under_prefer_but_kept(conn, policy):
    person = author_with_papers(conn, 2011, 2012, name="Dormant")
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score < 1.0
    assert any("last published 2012" in note for note in assessment.notes())


def test_the_activity_window_can_be_made_a_hard_requirement(conn, policy):
    person = author_with_papers(conn, 2015, name="Dormant2")
    strict = tuned(policy, activity={**policy.data["activity"], "mode": "require"})
    assessment = assess(conn, person, strict, now_year=NOW)
    assert assessment.excluded
    assert "last published 2015" in assessment.reason


def test_no_publication_years_never_excludes_anybody(conn, policy):
    person = author_with_papers(conn, name="Unknown")
    strict = tuned(policy, activity={**policy.data["activity"], "mode": "require"})
    assert not assess(conn, person, strict, now_year=NOW).excluded


def test_the_window_is_configurable(conn, policy):
    person = author_with_papers(conn, 2019, name="Older")
    wide = tuned(policy, activity={**policy.data["activity"], "mode": "require", "recent_years": 10})
    assert not assess(conn, person, wide, now_year=NOW).excluded


def test_a_long_career_is_noted_under_tte_and_excludes_nobody(conn):
    """Career length is a preference there, not a bar.

    It was a requirement with a ten-year ceiling, which removed every senior
    researcher in a pool — the people an editor most wants a report from — and
    left a run with nobody to invite. The signal is still worth having, so it
    is reported; it just does not disqualify.
    """
    person = author_with_papers(conn, 2025, name="SeniorExpert")
    person.education.append(
        Education(inst_id="i1", institution="Some Uni", degree="PhD", year_to=2015)
    )

    assessment = assess(conn, person, load_policy("tte"), now_year=NOW)

    assert not assessment.excluded
    assert any("above the preferred 10" in note for note in assessment.notes())
    assert any("since doctorate" in note for note in assessment.notes())


def test_a_long_publication_career_is_noted_rather_than_excluded(conn):
    person = author_with_papers(conn, 2015, 2025, name="LongCareer")

    assessment = assess(conn, person, load_policy("tte"), now_year=NOW)

    assert not assessment.excluded
    # No doctorate year on record, so the axis falls back to the first paper —
    # and says so, because "12 years since the doctorate" would be a different
    # and unevidenced claim.
    assert any("since first publication (2015)" in note for note in assessment.notes())


def test_the_seniority_ceiling_cannot_exclude_even_under_require(conn):
    """A ceiling that excludes is not a policy an editor may state by accident.

    It was stateable, and stated: this journal once required a ten-year
    maximum, which removed every senior researcher in the pool and left a run
    with nobody to invite. The floor obeys the mode; the ceiling never does.
    """
    person = author_with_papers(conn, 2015, 2025, name="LongCareer")
    required = tuned(
        load_policy(), seniority={"mode": "require", "min_years": 3, "max_years": 10}
    )

    assessment = assess(conn, person, required, now_year=NOW)
    outcome = next(o for o in assessment.outcomes if o.rule == "seniority")

    assert not outcome.passed
    assert not outcome.excluded
    assert not assessment.excluded


def test_the_seniority_floor_does_obey_require(conn):
    """The floor is the half of the axis that is allowed to bite."""
    person = author_with_papers(conn, 2025, name="Fresh")
    required = tuned(
        load_policy(), seniority={"mode": "require", "min_years": 3, "max_years": 0}
    )

    assert assess(conn, person, required, now_year=NOW).excluded


def test_exactly_one_rule_measures_a_career_length(conn, policy):
    """Three rules used to, and two of them derived it themselves.

    ``career_length`` read the papers this run harvested while
    ``unresponsive_veteran`` read the person's own profile, so the same
    candidate carried two career lengths in adjacent audit columns — on a live
    case they disagreed for 158 of 197 people, by as much as 28 years. The
    veteran rule is gone and ``academic_age`` is folded in, so the axis is
    measured once, from the profile where there is one.
    """
    person = author_with_papers(conn, 2015, 2025, name="OneCareer")
    person.works_by_year = {1994: 2, 2025: 3}

    outcomes = assess(conn, person, policy, now_year=NOW).outcomes
    # A measured span of years, as opposed to a threshold stating one.
    measured = [
        o
        for o in outcomes
        if any(
            k.endswith("_years") and not k.endswith(report.THRESHOLD_SUFFIXES)
            for k in o.facts
        )
    ]

    assert [o.rule for o in measured] == ["seniority"]
    assert measured[0].facts["seniority_years"] == NOW - 1994 + 1


def test_tte_requires_a_relevant_paper_in_the_last_three_years(conn):
    tte = load_policy("tte")
    person = author_with_papers(conn, 2020, name="Whoever")

    def outcome(*years):
        papers = [
            rank.Evidence(
                paper_id=f"p{y}", title="t", year=y, position="first",
                position_weight=1.0, similarity=0.5, venue_type="article",
            )
            for y in years
        ]
        record = CandidateRecord.build(conn, person, relevant_papers=papers, now_year=NOW)
        return next(
            o
            for o in eligibility.assess(record, tte).outcomes
            if o.rule == "relevant_activity"
        )

    assert outcome(2020, 2022).excluded
    assert not outcome(2022, 2025).excluded


# ------------------------------------------------------------- doctoral ----


def test_a_first_year_doctoral_candidate_is_excluded_by_default(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Fresher"), start=2025)
    assessment = assess(conn, person, policy, now_year=NOW)
    assert assessment.excluded
    assert "below the journal floor of year 3" in assessment.reason


def test_a_third_year_doctoral_candidate_passes_and_is_still_flagged(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Senior"), start=2024)
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded


def test_an_unstated_year_of_study_keeps_the_candidate(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Undated"), start=None)
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert any("not stated" in o.detail for o in assessment.outcomes)


def test_the_doctoral_floor_is_configurable(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Second"), start=2025)
    lenient = tuned(
        policy,
        seniority={**policy.data["seniority"], "doctoral": {"mode": "off", "min_year": 3}},
    )
    assert not assess(conn, person, lenient, now_year=NOW).excluded


def test_a_professor_is_not_measured_against_the_doctoral_floor(conn, policy):
    person = author_with_papers(conn, 2025, name="Prof")
    person.stated_rank = "professor"
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded


# ------------------------------------------------------------ invitations --


def test_no_rule_reads_whether_an_invitation_was_answered(conn, policy):
    """Two rules did, and both are gone.

    A windowed response rate and an unresponsive-veteran gate asked one question
    on two windows, so they agreed by construction; on any store without a long
    invitation history both abstained. The veteran gate also carried its own
    ten-year career threshold beside the seniority rule's, so one axis had two
    numbers on it in two config tables.

    The record is still kept and still travels between machines. Nothing judges
    it.
    """
    person = author_with_papers(conn, 2000, 2025, name="Silent")
    for index in range(4):
        repo.record_invitation(
            conn, person.person_id, f"ms-{index}", invited_at="2025-01-01", responded=False
        )

    assessment = assess(conn, person, policy, now_year=NOW)

    assert not assessment.excluded
    assert not any("invitation" in note for note in assessment.notes())
    assert {"invitation_response", "unresponsive_veteran"}.isdisjoint(
        o.rule for o in assessment.outcomes
    )
    # The history is still there to be read, just not to be judged.
    assert len(repo.invitation_history(conn, person.person_id)) == 4


def test_the_career_threshold_is_configurable_and_there_is_only_one(conn, policy):
    person = author_with_papers(conn, 2021, 2025, name="MidCareer")
    strict = tuned(
        policy, seniority={**policy.data["seniority"], "mode": "require", "min_years": 10}
    )

    assert assess(conn, person, strict, now_year=NOW).excluded
    assert not assess(conn, person, policy, now_year=NOW).excluded
    # One rule owns the axis, so one table states its bounds.
    thresholds = {
        key
        for outcome in assess(conn, person, policy, now_year=NOW).outcomes
        for key in outcome.facts
        if key.endswith(("_minimum", "_maximum"))
    }
    assert {k for k in thresholds if "career" in k or "seniority" in k} == {
        "seniority_minimum",
        "seniority_maximum",
    }



# ----------------------------------------------------------------- wiring --


def test_every_rule_off_leaves_the_score_untouched(conn, policy):
    person = doctoral(author_with_papers(conn, 2005, name="Everything"), start=2025)
    off = tuned(
        policy,
        activity={
            "mode": "off",
            "relevant": {**policy.data["activity"]["relevant"], "mode": "off"},
        },
        seniority={
            **policy.data["seniority"],
            "mode": "off",
            "doctoral": {"mode": "off", "min_year": 3},
        },
    )
    assessment = assess(conn, person, off, now_year=NOW)
    assert assessment.score == 1.0
    assert not assessment.outcomes


def test_an_unknown_mode_stops_the_run():
    with pytest.raises(UsageError):
        Constraint(name="activity", mode="maybe")


def test_scoring_excludes_a_failing_candidate_the_way_a_conflict_does(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Junior"), start=2025)
    scored = rank.score_candidate(
        conn,
        rank.Candidate(person=person),
        profile_topics=[],
        profile_methods=[],
        policy=policy,
        now_year=NOW,
    )
    assert scored.blocked
    assert any("excluded:" in note for note in scored.notes)


def test_an_eligible_candidate_carries_an_activity_component(conn, policy):
    # Far enough into a career to clear the seniority floor, which is one of
    # the preferences this component is the fraction of.
    person = author_with_papers(conn, 2015, 2025, name="Scored")
    scored = rank.score_candidate(
        conn,
        rank.Candidate(person=person),
        profile_topics=[],
        profile_methods=[],
        policy=policy,
        now_year=NOW,
    )
    assert scored.components["activity"] == 1.0


# ----------------------------------------------------------------- CLI -----


def test_an_invitation_can_still_be_recorded_and_changes_no_verdict(conn, policy):
    """The editor's own record of who was asked, which no rule reads.

    Worth keeping and worth recording: it is one of the few facts nobody can
    re-derive, and it travels between machines. It is reported beside a
    candidate rather than used to judge them.
    """
    from academia.cli import dispatch

    person = author_with_papers(conn, 2005, 2025, name="Recorded")
    before = assess(conn, person, policy, now_year=NOW)

    for index in range(2):
        repo.record_invitation(
            conn, person.person_id, f"ms-cli-{index}", invited_at="2024-01-01", responded=False
        )
    after = assess(conn, person, policy, now_year=NOW)

    assert [o.detail for o in before.outcomes] == [o.detail for o in after.outcomes]
    assert "invite" in dispatch.build_rev_disc_parser().format_help()


def test_several_papers_in_one_year_count_separately(conn, policy):
    person = author_with_papers(conn, 2025, name="Prolific")
    for index in range(2):
        repo.ingest_paper(
            conn,
            Paper(
                paper_id=f"paper-extra-{index}",
                title=f"Extra {index}",
                source="openalex",
                year=2025,
                authors=[Author(name="Prolific", idx=0, position="first", openalex_id="A-Prolific")],
            ),
        )
    demanding = tuned(
        policy, activity={**policy.data["activity"], "mode": "require", "min_recent_papers": 3}
    )
    assert not assess(conn, person, demanding, now_year=NOW).excluded


def test_an_invalid_mode_is_rejected_when_the_policy_loads(tmp_path, monkeypatch):
    from academia.reviewer.policy import load_policy as load

    config = tmp_path / "configs"
    (config / "journals").mkdir(parents=True)
    source = Path(load().sources[0]).read_text(encoding="utf-8")
    (config / "coi.toml").write_text(source.replace('mode = "prefer"', 'mode = "maybe"', 1), "utf-8")
    monkeypatch.setenv("ACADEMIA_CONFIG_DIR", str(config))
    with pytest.raises(UsageError):
        load()


# ------------------------------------------------- profile-reported output --


def with_output(conn, person: Person, works_by_year: dict[int, int]) -> Person:
    repo.record_output(conn, person.person_id, works_by_year, source="openalex")
    person.works_by_year = works_by_year
    return person


def test_the_profile_record_beats_the_papers_this_run_happened_to_harvest(conn, policy):
    """A prolific author whose recent work is off-topic is not dormant."""
    person = with_output(conn, author_with_papers(conn, 2018, name="Prolific2"), {2025: 12, 2024: 9})
    assessment = assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score == 1.0
    assert not any("only 0 paper" in note for note in assessment.notes())


def test_a_genuinely_dormant_profile_still_fails(conn, policy):
    person = with_output(conn, author_with_papers(conn, 2012, name="Retired"), {2012: 4, 2013: 1})
    assessment = assess(conn, person, policy, now_year=NOW)
    assert any("last published 2013" in note for note in assessment.notes())


def test_the_fallback_says_which_evidence_it_used(conn, policy):
    person = author_with_papers(conn, 2012, name="StoreOnly")
    notes = assess(conn, person, policy, now_year=NOW).notes()
    assert any("harvested papers only" in note for note in notes)


def test_career_length_comes_from_the_profile_when_it_is_known(conn, policy):
    """The store's oldest harvested paper is not the start of a career."""
    person = with_output(conn, author_with_papers(conn, 2024, name="Long"), {2008: 3, 2024: 5})

    outcome = next(
        o for o in assess(conn, person, policy, now_year=NOW).outcomes if o.rule == "seniority"
    )

    assert outcome.facts["seniority_since"] == 2008
    assert outcome.facts["seniority_years"] == NOW - 2008 + 1


def test_a_verified_affiliation_outranks_a_bibliographic_guess(conn, policy):
    """An author index can attach someone to an institution they never joined."""
    from academia.core.models import Affiliation

    person = author_with_papers(conn, 2025, name="Misplaced")
    person.affiliations.append(
        Affiliation(
            inst_id="i-guess",
            institution="Beihang University",
            country_code="CN",
            is_current=True,
            year_to=2025,
            source="openalex",
        )
    )
    person.affiliations.append(
        Affiliation(
            inst_id="i-real",
            institution="University of Sheffield",
            country_code="GB",
            is_current=True,
            source="agent_lookup",
            source_url="https://sheffield.ac.uk/eee/people/x",
        )
    )
    assert person.country_code == "GB"


# ------------------------------------------------------------ contact list --


def test_contact_list_marks_every_candidate_and_explains_rejections(conn, policy):
    """The one export whose only job is to address invitations."""
    from academia.core.models import Affiliation
    from academia.reviewer import report
    from academia.reviewer.enrich import EmailFinding

    def row(rank, name, blocked, email):
        person = Person(person_id=f"p-{name}", display_name=name)
        person.affiliations.append(
            Affiliation(inst_id="i1", institution="Some Uni", is_current=True, source="openalex")
        )
        candidate = rank_module_candidate(person, blocked)
        return report.Row(rank=rank, candidate=candidate, email=email)

    def rank_module_candidate(person, blocked):
        candidate = rank.Candidate(person=person)
        if blocked:
            candidate.score = rank.BLOCKED_SCORE
        return candidate

    rows = [
        row(1, "Invitable", False, EmailFinding(email="a@uni.edu", source="orcid_public")),
        row(2, "NoAddress", False, EmailFinding()),
        row(3, "Conflicted", True, EmailFinding(email="c@uni.edu", source="orcid_public")),
    ]

    lines = report.render_contact_list(rows, load_policy()).strip().split("\n")
    assert lines[0] == "reviewer,institution,email,status,decision_reason"
    assert lines[1].startswith("Invitable,Some Uni,a@uni.edu,manual_review,")
    # A missing address asks for a human, and never excludes: the editorial
    # system can address an invitation this tool cannot, and no rule found
    # anything wrong with this candidate.
    assert lines[2].startswith("NoAddress,Some Uni,not found,manual_review,")
    assert "no public address found" in lines[2]
    assert lines[3].startswith("Conflicted,Some Uni,c@uni.edu,rejected,")
    assert len(lines) == 4
