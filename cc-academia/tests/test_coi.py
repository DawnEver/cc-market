"""The COI engine is the part an editor may have to defend in writing."""

from __future__ import annotations

import pytest

from academia.core.models import Affiliation, Author, Education, Institution, Paper, Person
from academia.reviewer import coi
from academia.reviewer.policy import load_policy
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "coi.db")
    yield connection
    connection.close()


@pytest.fixture()
def policy():
    return load_policy()


def make_person(person_id="p-cand", name="Candidate One", **kwargs) -> Person:
    return Person(person_id=person_id, display_name=name, **kwargs)


def context(**kwargs) -> coi.ManuscriptContext:
    defaults = dict(ms_id="ms1", author_names=["Alice Author"], year=2026)
    defaults.update(kwargs)
    return coi.ManuscriptContext(**defaults)


def add_affiliation(person: Person, name: str, *, department="", current=True, year_from=2020):
    institution = Institution.build(name=name, country_code="GB")
    person.affiliations.append(
        Affiliation(
            inst_id=institution.inst_id,
            institution=name,
            country_code="GB",
            department=department,
            is_current=current,
            year_from=year_from,
            source="openalex",
        )
    )
    return institution


# ------------------------------------------------------------- outcomes ----


def test_a_clean_candidate_is_reported_as_no_detected_conflict(conn, policy):
    verdict = coi.evaluate(conn, make_person(), context(), policy)
    assert verdict.status == coi.CLEAR
    assert verdict.summary() == "no detected conflict"
    assert verdict.summary() != "no conflict"


def test_manuscript_author_is_blocked_by_name(conn, policy):
    person = make_person(name="Alice Author")
    verdict = coi.evaluate(conn, person, context(), policy)
    assert verdict.blocked
    assert verdict.findings[0].rule == "manuscript_author"


def test_manuscript_author_is_blocked_through_a_name_variant(conn, policy):
    person = make_person(name="A. Author")
    person.names = ["Author, Alice"]
    verdict = coi.evaluate(conn, person, context(), policy)
    assert verdict.blocked


def test_manuscript_author_is_blocked_by_resolved_identity(conn, policy):
    person = make_person(person_id="p-42", name="Someone Else")
    verdict = coi.evaluate(conn, person, context(author_person_ids=["p-42"]), policy)
    assert verdict.blocked
    assert verdict.findings[0].evidence["matched_by"] == "person_id"


def test_exclusion_list_blocks(conn):
    policy = load_policy(exclusion_list=["Candidate One"])
    verdict = coi.evaluate(conn, make_person(), context(), policy)
    assert verdict.blocked
    assert any(f.rule == "exclusion_list" for f in verdict.findings)


# --------------------------------------------------------- co-authorship ----


def _coauthored(conn, year):
    a = Author(name="Candidate One", idx=0, openalex_id="A-cand")
    b = Author(name="Alice Author", idx=1, openalex_id="A-auth")
    paper = Paper.build(title=f"Joint work {year}", source="openalex", doi=f"10.1/{year}", year=year)
    paper.authors = [a, b]
    _, ids = repo.ingest_paper(conn, paper)
    return ids


def test_recent_coauthorship_blocks(conn, policy):
    cand_id, author_id = _coauthored(conn, 2024)
    person = make_person(person_id=cand_id)
    verdict = coi.evaluate(conn, person, context(author_person_ids=[author_id]), policy)
    assert verdict.blocked
    finding = next(f for f in verdict.findings if f.rule == "recent_coauthor")
    assert finding.evidence["last_year"] == 2024


def test_old_isolated_coauthorship_does_not_block(conn, policy):
    cand_id, author_id = _coauthored(conn, 2012)
    person = make_person(person_id=cand_id)
    verdict = coi.evaluate(conn, person, context(author_person_ids=[author_id]), policy)
    assert verdict.status == coi.CLEAR


def test_old_but_dense_collaboration_is_flagged_for_review(conn, policy):
    for year in (2010, 2011, 2012):
        cand_id, author_id = _coauthored(conn, year)
    person = make_person(person_id=cand_id)
    verdict = coi.evaluate(conn, person, context(author_person_ids=[author_id]), policy)
    assert verdict.status == coi.REVIEW
    assert any(f.rule == "dense_historic_collaboration" for f in verdict.findings)


def test_the_coauthor_window_is_journal_configurable(conn):
    cand_id, author_id = _coauthored(conn, 2022)
    person = make_person(person_id=cand_id)
    ctx = context(author_person_ids=[author_id], year=2026)

    assert coi.evaluate(conn, person, ctx, load_policy()).blocked          # 5-year window
    assert not coi.evaluate(conn, person, ctx, load_policy("tte")).blocked  # 4-year window


# --------------------------------------------------------- institutions ----


def test_same_department_blocks_but_same_institution_only_flags(conn, policy):
    shared = "University of Nottingham"

    same_dept = make_person(person_id="p-dept")
    add_affiliation(same_dept, shared, department="Electrical Engineering")
    verdict = coi.evaluate(conn, same_dept, context(author_institutions=[shared]), policy)
    assert verdict.blocked

    same_inst = make_person(person_id="p-inst")
    add_affiliation(same_inst, shared)
    verdict = coi.evaluate(conn, same_inst, context(author_institutions=[shared]), policy)
    assert verdict.status == coi.REVIEW


def test_previous_institution_overlap_is_flagged(conn, policy):
    person = make_person()
    add_affiliation(person, "Somewhere Else", current=True)
    add_affiliation(person, "Shared University", current=False, year_from=2012)
    verdict = coi.evaluate(conn, person, context(author_institutions=["Shared University"]), policy)
    assert any(f.rule == "previous_institution_overlap" for f in verdict.findings)


# ------------------------------------------------------------- education ----


def test_a_shared_doctorate_in_overlapping_years_blocks(conn, policy):
    institution = Institution.build(name="Shared University")
    candidate = make_person()
    candidate.education.append(
        Education(inst_id=institution.inst_id, institution="Shared University", degree="PhD", year_to=2015, source="orcid")
    )
    author = make_person(person_id="p-auth", name="Alice Author")
    author.education.append(
        Education(inst_id=institution.inst_id, institution="Shared University", degree="PhD", year_to=2016, source="orcid")
    )

    verdict = coi.evaluate(conn, candidate, context(), policy, manuscript_people=[author])
    assert verdict.blocked
    assert any(f.rule == "same_phd_institution_overlap" for f in verdict.findings)


def test_a_shared_doctorate_decades_apart_does_not_block(conn, policy):
    institution = Institution.build(name="Shared University")
    candidate = make_person()
    candidate.education.append(
        Education(inst_id=institution.inst_id, degree="PhD", year_to=1995, source="orcid")
    )
    author = make_person(person_id="p-auth", name="Alice Author")
    author.education.append(
        Education(inst_id=institution.inst_id, degree="PhD", year_to=2020, source="orcid")
    )
    verdict = coi.evaluate(conn, candidate, context(), policy, manuscript_people=[author])
    assert verdict.status == coi.CLEAR


def test_missing_graduation_years_cannot_manufacture_a_conflict(conn, policy):
    """ORCID leaves the dates empty often enough that this must be safe."""
    institution = Institution.build(name="Shared University")
    candidate = make_person()
    candidate.education.append(Education(inst_id=institution.inst_id, degree="PhD", source="orcid"))
    author = make_person(person_id="p-auth", name="Alice Author")
    author.education.append(Education(inst_id=institution.inst_id, degree="PhD", source="orcid"))
    verdict = coi.evaluate(conn, candidate, context(), policy, manuscript_people=[author])
    assert verdict.status == coi.CLEAR


def test_advisor_relationship_blocks_in_both_directions(conn, policy):
    author = make_person(person_id="p-auth", name="Alice Author")
    candidate = make_person()
    candidate.education.append(
        Education(inst_id="inst-1", degree="PhD", advisor_person_id="p-auth", source="orcid", source_url="https://orcid.org/x")
    )
    assert coi.evaluate(conn, candidate, context(), policy, manuscript_people=[author]).blocked

    candidate2 = make_person(person_id="p-supervisor")
    author2 = make_person(person_id="p-auth2", name="Alice Author")
    author2.education.append(
        Education(inst_id="inst-1", degree="PhD", advisor_person_id="p-supervisor", source="orcid")
    )
    assert coi.evaluate(conn, candidate2, context(), policy, manuscript_people=[author2]).blocked


# -------------------------------------------------------------- citation ----


def test_heavy_citation_flags_without_blocking(conn, policy):
    person_ids = []
    referenced = []
    for i in range(4):
        paper = Paper.build(title=f"Prior work {i}", source="openalex", doi=f"10.9/{i}", year=2022)
        paper.authors = [Author(name="Candidate One", idx=0, openalex_id="A-cand")]
        paper_id, ids = repo.ingest_paper(conn, paper)
        referenced.append(paper_id)
        person_ids = ids

    person = make_person(person_id=person_ids[0])
    verdict = coi.evaluate(conn, person, context(referenced_paper_ids=referenced), policy)
    assert verdict.status == coi.REVIEW
    assert not verdict.blocked


# ----------------------------------------------------------- audit trail ----


def test_every_rule_runs_even_after_the_first_block(conn, policy):
    shared = "Shared University"
    person = make_person(name="Alice Author")
    add_affiliation(person, shared, department="EE")
    verdict = coi.evaluate(conn, person, context(author_institutions=[shared]), policy)
    rules = {f.rule for f in verdict.findings}
    assert {"manuscript_author", "same_department"} <= rules


def test_a_clean_verdict_still_leaves_an_audit_record(conn, policy):
    repo.create_manuscript(conn, ms_id="ms1", journal="tie", title_hash="h", origin_countries=["CN"])
    repo.create_run(conn, run_id="run1", ms_id="ms1")
    repo.upsert_person(conn, Author(name="Candidate One", idx=0, openalex_id="A-cand"))
    person = make_person(person_id=repo.upsert_person(conn, Author(name="Candidate One", idx=0, openalex_id="A-cand")))

    verdict = coi.evaluate(conn, person, context(), policy)
    coi.persist(conn, "run1", verdict)

    rows = repo.coi_for(conn, "run1", person.person_id)
    assert len(rows) == 1
    assert rows[0]["status"] == "CLEAR"
    assert "no detected conflict" in rows[0]["evidence_json"]


def test_policy_fingerprint_changes_with_the_journal():
    assert load_policy().fingerprint() != load_policy("tte").fingerprint()


def test_unknown_journal_is_refused_rather_than_silently_defaulted():
    from academia.core.errors import UsageError

    with pytest.raises(UsageError):
        load_policy("no-such-journal")


def test_journal_overlay_only_changes_what_it_states():
    base = load_policy()
    tte = load_policy("tte")
    assert tte.coauthor_years == 4
    assert tte.block_rules == base.block_rules
    assert tte.weights == base.weights


def test_journal_overlay_can_change_retrieval_without_forking_defaults(tmp_path, monkeypatch):
    override = tmp_path / "configs"
    (override / "journals").mkdir(parents=True)
    (override / "journals" / "tte.toml").write_text(
        "[retrieval]\nmax_papers_per_candidate = 7\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("ACADEMIA_CONFIG_DIR", str(override))

    policy = load_policy("tte")

    assert policy.retrieval_int("max_papers_per_candidate", 4) == 7
    assert policy.retrieval_int("host_failure_budget", 2) == 2
