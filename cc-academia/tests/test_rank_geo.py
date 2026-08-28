"""Geography is a preference; a conflict is a wall. The two must not blend."""

from __future__ import annotations

import math

import pytest

from academia.core.models import Affiliation, Author, Education, Person
from academia.reviewer import coi, geo, rank
from academia.reviewer.policy import Policy, load_policy
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "rank.db")
    yield connection
    connection.close()


@pytest.fixture()
def policy():
    return load_policy()


def person_in(country: str, *, topics=None, person_id="p1", confidence=0.99) -> Person:
    person = Person(
        person_id=person_id,
        display_name="Candidate",
        confidence=confidence,
        resolution_method="orcid",
        topics=topics or ["Electric Motor Design and Analysis"],
    )
    if country:
        person.affiliations.append(
            Affiliation(inst_id="i1", institution="Some Uni", country_code=country, is_current=True, source="openalex")
        )
    return person


def hard_policy() -> Policy:
    base = load_policy()
    data = {**base.data, "geo": {**base.data["geo"], "mode": "hard_filter"}}
    return Policy(data=data, sources=base.sources, journal=base.journal)


# ------------------------------------------------------------- geography ----


def test_cross_region_earns_a_bonus(policy):
    assessment = geo.assess(person_in("GB"), ["CN"], policy)
    assert assessment.cross_region
    assert assessment.bonus == pytest.approx(0.08)
    assert not assessment.excluded


def test_same_region_earns_nothing_but_is_not_excluded(policy):
    assessment = geo.assess(person_in("CN"), ["CN"], policy)
    assert not assessment.cross_region
    assert assessment.bonus == 0.0
    assert not assessment.excluded


def test_country_comes_from_the_current_post_not_from_a_name(policy):
    """A Chinese researcher now at Stanford counts as US."""
    person = Person(person_id="p", display_name="Wei Zhang", resolution_method="orcid")
    person.affiliations.append(
        Affiliation(inst_id="i", institution="Stanford University", country_code="US", is_current=True, source="openalex")
    )
    assert geo.assess(person, ["CN"], policy).cross_region


def test_unknown_country_is_neither_rewarded_nor_punished(policy):
    assessment = geo.assess(person_in(""), ["CN"], policy)
    assert assessment.bonus == 0.0
    assert not assessment.excluded
    assert "unknown" in assessment.reason


def test_hard_filter_excludes_same_region_only():
    strict = hard_policy()
    assert geo.assess(person_in("CN"), ["CN"], strict).excluded
    assert not geo.assess(person_in("GB"), ["CN"], strict).excluded


def test_hard_filter_still_spares_an_unknown_country():
    assert not geo.assess(person_in(""), ["CN"], hard_policy()).excluded


def test_origin_countries_prefer_explicit_codes_over_affiliation_text():
    assert geo.origin_countries_from(["Tsinghua University, Beijing"], ["GB"]) == ["GB"]
    assert geo.origin_countries_from(["Tsinghua University, Beijing, China"], []) == ["CN"]
    assert geo.origin_countries_from(["Some Unrecognisable Institute"], []) == []


# ---------------------------------------------------------------- scoring ----


def make_candidate(person: Person, *, evidence=1, similarity=0.9, year=2025) -> rank.Candidate:
    candidate = rank.Candidate(person=person)
    for i in range(evidence):
        candidate.evidence.append(
            rank.Evidence(
                paper_id=f"paper-{i}",
                title=f"Relevant work {i}",
                year=year,
                position="first",
                position_weight=1.0,
                similarity=similarity,
            )
        )
    return candidate


def test_a_block_removes_the_candidate_rather_than_penalising_them(conn, policy):
    candidate = make_candidate(person_in("GB"))
    candidate.verdict = coi.Verdict(person_id="p1", status=coi.BLOCK)
    candidate.verdict.add(coi.Finding("recent_coauthor", coi.BLOCK, {}))

    scored = rank.score_candidate(
        conn, candidate, profile_topics=["Electric Motor Design and Analysis"],
        profile_methods=[], policy=policy, now_year=2026,
    )
    assert scored.score == -math.inf
    assert scored.components == {}


def test_expertise_can_never_outrank_a_conflict(conn, policy):
    """The failure mode this design exists to prevent."""
    expert = make_candidate(person_in("GB", person_id="expert"), evidence=5)
    expert.verdict = coi.Verdict(person_id="expert", status=coi.BLOCK)
    expert.verdict.add(coi.Finding("recent_coauthor", coi.BLOCK, {}))

    ordinary = make_candidate(person_in("GB", person_id="ordinary"), evidence=1, similarity=0.4)
    ordinary.verdict = coi.Verdict(person_id="ordinary")

    scored = [
        rank.score_candidate(conn, c, profile_topics=["Electric Motor Design and Analysis"],
                             profile_methods=[], policy=policy, now_year=2026)
        for c in (expert, ordinary)
    ]
    assert rank.rank(scored)[0].person.person_id == "ordinary"


def test_blocked_candidates_are_kept_at_the_bottom_not_deleted(conn, policy):
    """An editor needs to see that the obvious name was considered and why not."""
    blocked = make_candidate(person_in("GB", person_id="blocked"))
    blocked.verdict = coi.Verdict(person_id="blocked", status=coi.BLOCK)
    clear = make_candidate(person_in("GB", person_id="clear"))
    clear.verdict = coi.Verdict(person_id="clear")

    ordered = rank.rank([blocked, clear])
    assert [c.person.person_id for c in ordered] == ["clear", "blocked"]


def test_review_status_sorts_below_clear_regardless_of_score(conn, policy):
    flagged = make_candidate(person_in("GB", person_id="flagged"), evidence=5)
    flagged.verdict = coi.Verdict(person_id="flagged", status=coi.REVIEW)
    clean = make_candidate(person_in("GB", person_id="clean"), evidence=1, similarity=0.3)
    clean.verdict = coi.Verdict(person_id="clean")

    scored = [
        rank.score_candidate(conn, c, profile_topics=["Electric Motor Design and Analysis"],
                             profile_methods=[], policy=policy, now_year=2026)
        for c in (flagged, clean)
    ]
    assert rank.rank(scored)[0].person.person_id == "clean"


def test_geographic_exclusion_uses_the_same_wall_as_a_conflict(conn):
    strict = hard_policy()
    candidate = make_candidate(person_in("CN"))
    candidate.geo = geo.assess(candidate.person, ["CN"], strict)
    scored = rank.score_candidate(
        conn, candidate, profile_topics=[], profile_methods=[], policy=strict, now_year=2026
    )
    assert scored.score == -math.inf


def test_first_author_evidence_outweighs_middle_author_evidence(conn, policy):
    topics = ["Electric Motor Design and Analysis"]
    lead = rank.Candidate(person=person_in("GB", person_id="lead", topics=topics))
    lead.evidence = [rank.Evidence("p", "t", 2025, "first", 1.0, 0.9)]
    helper = rank.Candidate(person=person_in("GB", person_id="helper", topics=topics))
    helper.evidence = [rank.Evidence("p", "t", 2025, "middle", 0.4, 0.9)]

    scored = [
        rank.score_candidate(conn, c, profile_topics=topics, profile_methods=[], policy=policy, now_year=2026)
        for c in (lead, helper)
    ]
    assert scored[0].score > scored[1].score


def test_evidence_saturates_so_volume_alone_does_not_win(conn, policy):
    topics = ["Electric Motor Design and Analysis"]
    many = make_candidate(person_in("GB", person_id="many", topics=topics), evidence=20)
    scored = rank.score_candidate(
        conn, many, profile_topics=topics, profile_methods=[], policy=policy, now_year=2026
    )
    assert scored.components["publication_evidence"] == 1.0


def test_a_reviewer_who_never_responded_is_pushed_down(conn, policy):
    person = person_in("GB", person_id=repo.upsert_person(conn, Author(name="Silent", idx=0, openalex_id="A1")))
    repo.record_invitation(conn, person.person_id, "ms-old", responded=False)

    candidate = make_candidate(person)
    scored = rank.score_candidate(
        conn, candidate, profile_topics=[], profile_methods=[], policy=policy, now_year=2026
    )
    assert scored.components["reviewer_history"] == 0.0
    assert any("never responded" in n for n in scored.notes)


def test_no_history_is_neutral_rather_than_negative(conn, policy):
    candidate = make_candidate(person_in("GB"))
    scored = rank.score_candidate(
        conn, candidate, profile_topics=[], profile_methods=[], policy=policy, now_year=2026
    )
    assert scored.components["reviewer_history"] == 0.5


def test_low_identity_confidence_is_surfaced_not_hidden(conn, policy):
    person = person_in("GB", confidence=0.3)
    person.resolution_method = "name_only"
    scored = rank.score_candidate(
        conn, make_candidate(person), profile_topics=[], profile_methods=[], policy=policy, now_year=2026
    )
    assert any("confirm before inviting" in n for n in scored.notes)


def test_seniority_is_noted_but_never_excludes(conn, policy):
    person = person_in("GB")
    person.education.append(Education(inst_id="i", degree="PhD", year_to=2025, source="orcid"))
    scored = rank.score_candidate(
        conn, make_candidate(person), profile_topics=[], profile_methods=[], policy=policy, now_year=2026
    )
    assert scored.score > -math.inf
    assert any("academic age" in n for n in scored.notes)


def test_score_components_are_all_reported(conn, policy):
    scored = rank.score_candidate(
        conn, make_candidate(person_in("GB")), profile_topics=["Electric Motor Design and Analysis"],
        profile_methods=["finite element"], policy=policy, now_year=2026,
    )
    assert set(scored.components) == set(policy.weights)
