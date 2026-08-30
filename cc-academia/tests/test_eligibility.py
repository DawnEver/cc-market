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
from academia.reviewer import eligibility, rank
from academia.reviewer.policy import Constraint, Policy, load_policy
from academia.store import db
from academia.store import repository as repo

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
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score == 1.0


def test_a_dormant_author_is_flagged_under_prefer_but_kept(conn, policy):
    person = author_with_papers(conn, 2011, 2012, name="Dormant")
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score < 1.0
    assert any("last published 2012" in note for note in assessment.notes())


def test_the_activity_window_can_be_made_a_hard_requirement(conn, policy):
    person = author_with_papers(conn, 2015, name="Dormant2")
    strict = tuned(policy, activity={**policy.data["activity"], "mode": "require"})
    assessment = eligibility.assess(conn, person, strict, now_year=NOW)
    assert assessment.excluded
    assert "last published 2015" in assessment.reason


def test_no_publication_years_never_excludes_anybody(conn, policy):
    person = author_with_papers(conn, name="Unknown")
    strict = tuned(policy, activity={**policy.data["activity"], "mode": "require"})
    assert not eligibility.assess(conn, person, strict, now_year=NOW).excluded


def test_the_window_is_configurable(conn, policy):
    person = author_with_papers(conn, 2019, name="Older")
    wide = tuned(policy, activity={**policy.data["activity"], "mode": "require", "recent_years": 10})
    assert not eligibility.assess(conn, person, wide, now_year=NOW).excluded


# ------------------------------------------------------------- doctoral ----


def test_a_first_year_doctoral_candidate_is_excluded_by_default(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Fresher"), start=2025)
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert assessment.excluded
    assert "below the journal floor of year 3" in assessment.reason


def test_a_third_year_doctoral_candidate_passes_and_is_still_flagged(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Senior"), start=2024)
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded


def test_an_unstated_year_of_study_keeps_the_candidate(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Undated"), start=None)
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert any("not stated" in o.detail for o in assessment.outcomes)


def test_the_doctoral_floor_is_configurable(conn, policy):
    person = doctoral(author_with_papers(conn, 2025, name="Second"), start=2025)
    lenient = tuned(
        policy,
        seniority={**policy.data["seniority"], "doctoral": {"mode": "off", "min_year": 3}},
    )
    assert not eligibility.assess(conn, person, lenient, now_year=NOW).excluded


def test_a_professor_is_not_measured_against_the_doctoral_floor(conn, policy):
    person = author_with_papers(conn, 2025, name="Prof")
    person.stated_rank = "professor"
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded


# ------------------------------------------------------------ invitations --


def test_recent_silence_is_flagged_once_there_is_enough_history(conn, policy):
    person = author_with_papers(conn, 2025, name="Silent")
    for index in range(3):
        repo.record_invitation(
            conn, person.person_id, f"ms-{index}", invited_at="2025-01-01", responded=False
        )
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded  # prefer, not require
    assert any("responded to only 0%" in note for note in assessment.notes())


def test_old_invitations_fall_outside_the_response_window(conn, policy):
    person = author_with_papers(conn, 2025, name="Reformed")
    repo.record_invitation(conn, person.person_id, "ms-old", invited_at="2015-01-01", responded=False)
    strict = tuned(
        policy,
        activity={
            **policy.data["activity"],
            "invitations": {**policy.data["activity"]["invitations"], "mode": "require"},
        },
    )
    assert not eligibility.assess(conn, person, strict, now_year=NOW).excluded


def test_an_empty_invitation_history_is_neutral(conn, policy):
    person = author_with_papers(conn, 2025, name="Fresh")
    strict = tuned(
        policy,
        activity={
            **policy.data["activity"],
            "invitations": {**policy.data["activity"]["invitations"], "mode": "require"},
        },
    )
    assert not eligibility.assess(conn, person, strict, now_year=NOW).excluded


# --------------------------------------------------------------- veteran ---


def test_a_long_career_with_no_response_is_excluded(conn, policy):
    person = author_with_papers(conn, 2005, 2025, name="Veteran")
    for index in range(2):
        repo.record_invitation(
            conn, person.person_id, f"ms-v{index}", invited_at="2024-01-01", responded=False
        )
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert assessment.excluded
    assert "stopped accepting review work" in assessment.reason


def test_a_long_career_alone_is_never_a_reason(conn, policy):
    person = author_with_papers(conn, 2000, 2025, name="Elder")
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded


def test_a_veteran_who_does_respond_stays(conn, policy):
    person = author_with_papers(conn, 2005, 2025, name="Willing")
    repo.record_invitation(conn, person.person_id, "ms-a", invited_at="2024-01-01", responded=True)
    repo.record_invitation(conn, person.person_id, "ms-b", invited_at="2025-01-01", responded=False)
    assert not eligibility.assess(conn, person, policy, now_year=NOW).excluded


def test_the_career_length_is_configurable(conn, policy):
    person = author_with_papers(conn, 2021, 2025, name="MidCareer")
    for index in range(2):
        repo.record_invitation(
            conn, person.person_id, f"ms-m{index}", invited_at="2025-01-01", responded=False
        )
    strict = tuned(
        policy,
        activity={
            **policy.data["activity"],
            "veteran": {**policy.data["activity"]["veteran"], "career_years": 5},
        },
    )
    assert eligibility.assess(conn, person, strict, now_year=NOW).excluded
    assert not eligibility.assess(conn, person, policy, now_year=NOW).excluded


# ----------------------------------------------------------------- wiring --


def test_every_rule_off_leaves_the_score_untouched(conn, policy):
    person = doctoral(author_with_papers(conn, 2005, name="Everything"), start=2025)
    off = tuned(
        policy,
        activity={
            "mode": "off",
            "invitations": {**policy.data["activity"]["invitations"], "mode": "off"},
            "veteran": {**policy.data["activity"]["veteran"], "mode": "off"},
        },
        seniority={**policy.data["seniority"], "doctoral": {"mode": "off", "min_year": 3}},
    )
    assessment = eligibility.assess(conn, person, off, now_year=NOW)
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
    person = author_with_papers(conn, 2025, name="Scored")
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


def test_recording_an_invitation_feeds_the_responsiveness_rules(conn, policy):
    """The veteran rule is inert until an outcome can actually be written down."""
    from academia.cli import dispatch

    person = author_with_papers(conn, 2005, 2025, name="Recorded")
    assert not eligibility.assess(conn, person, policy, now_year=NOW).excluded

    for index in range(2):
        repo.record_invitation(
            conn,
            person.person_id,
            f"ms-cli-{index}",
            invited_at="2024-01-01",
            responded=False,
        )
    assert eligibility.assess(conn, person, policy, now_year=NOW).excluded
    assert "invite" in dispatch.build_rev_disc_parser().format_help()


def test_an_unresolved_outcome_is_not_a_silence(conn, policy):
    person = author_with_papers(conn, 2005, 2025, name="Pending")
    for index in range(3):
        repo.record_invitation(
            conn, person.person_id, f"ms-p{index}", invited_at="2025-01-01", responded=None
        )
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert not any("responded to only" in note for note in assessment.notes())


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
    assert not eligibility.assess(conn, person, demanding, now_year=NOW).excluded


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
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert not assessment.excluded
    assert assessment.score == 1.0
    assert not any("only 0 paper" in note for note in assessment.notes())


def test_a_genuinely_dormant_profile_still_fails(conn, policy):
    person = with_output(conn, author_with_papers(conn, 2012, name="Retired"), {2012: 4, 2013: 1})
    assessment = eligibility.assess(conn, person, policy, now_year=NOW)
    assert any("last published 2013" in note for note in assessment.notes())


def test_the_fallback_says_which_evidence_it_used(conn, policy):
    person = author_with_papers(conn, 2012, name="StoreOnly")
    notes = eligibility.assess(conn, person, policy, now_year=NOW).notes()
    assert any("harvested papers only" in note for note in notes)


def test_career_length_comes_from_the_profile_when_it_is_known(conn, policy):
    """The store's oldest harvested paper is not the start of a career."""
    person = with_output(conn, author_with_papers(conn, 2024, name="Long"), {2008: 3, 2024: 5})
    for index in range(2):
        repo.record_invitation(
            conn, person.person_id, f"ms-l{index}", invited_at="2025-01-01", responded=False
        )
    assert eligibility.assess(conn, person, policy, now_year=NOW).excluded


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


def test_the_contact_list_is_three_columns_and_omits_blocked_candidates(conn, policy):
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

    lines = report.render_contact_list(rows).strip().split("\n")
    assert lines[0] == "reviewer,email,institution"
    assert lines[1] == "Invitable,a@uni.edu,Some Uni"
    assert lines[2] == "NoAddress,not found,Some Uni"
    assert len(lines) == 3  # the blocked candidate is not addressable
