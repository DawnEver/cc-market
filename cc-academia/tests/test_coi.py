"""The COI engine is the part an editor may have to defend in writing."""

from __future__ import annotations

from pathlib import Path

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


def test_the_coauthor_window_is_journal_configurable(conn, tmp_path, monkeypatch):
    """Configurable in either direction — the overlay decides, not the engine."""
    (tmp_path / "journals").mkdir()
    (tmp_path / "coi.toml").write_text(
        (Path(__file__).parents[1] / "configs" / "coi.toml").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (tmp_path / "journals" / "wide.toml").write_text(
        chr(10).join(['journal = "Wide"', "[windows]", "coauthor_years = 8", ""]),
        encoding="utf-8",
    )
    monkeypatch.setenv("ACADEMIA_CONFIG_DIR", str(tmp_path))

    cand_id, author_id = _coauthored(conn, 2020)
    person = make_person(person_id=cand_id)
    ctx = context(author_person_ids=[author_id], year=2026)

    assert not coi.evaluate(conn, person, ctx, load_policy()).blocked   # 5-year window
    assert coi.evaluate(conn, person, ctx, load_policy("wide")).blocked  # 8-year window


# --------------------------------------------------------- institutions ----


def test_same_department_blocks_but_same_institution_only_flags(conn, policy):
    """A department has to be named on both sides for the block to be earned.

    Blocking because the candidate's own record happens to carry a department
    field turns the richness of one person's record into a conflict finding: the
    submitting author's department was never consulted, so nothing was compared.
    """
    shared = "University of Nottingham"
    department = "Electrical Engineering"

    same_dept = make_person(person_id="p-dept")
    add_affiliation(same_dept, shared, department=department)
    stated = context(author_institutions=[f"{department}, {shared}"])
    assert coi.evaluate(conn, same_dept, stated, policy).blocked

    # Same university, and the submission says nothing about a department.
    verdict = coi.evaluate(conn, same_dept, context(author_institutions=[shared]), policy)
    assert verdict.status == coi.REVIEW
    assert {f.rule for f in verdict.findings} == {"same_institution"}

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
    verdict = coi.evaluate(conn, person, context(author_institutions=[f"EE, {shared}"]), policy)
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
    assert tte.coauthor_years == base.coauthor_years  # inherited, not narrowed
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


def test_email_precedence_must_cover_every_configured_source(tmp_path, monkeypatch):
    override = tmp_path / "configs"
    (override / "journals").mkdir(parents=True)
    (override / "journals" / "tte.toml").write_text(
        '[retrieval]\nemail_precedence = ["orcid_public"]\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("ACADEMIA_CONFIG_DIR", str(override))

    from academia.core.errors import UsageError

    with pytest.raises(UsageError, match="email_precedence must list every"):
        load_policy("tte")


# ------------------------------------------- identity of the submitting authors


def test_an_affiliation_line_from_the_pdf_still_matches_the_institution(conn, policy):
    """A PDF gives one string per author, not a parsed institution.

    "the School of Electrical Engineering, Southeast University, Nanjing 210096,
    China" has to match a candidate whose employer is recorded as "Southeast
    University", or the institutional rules pass vacuously on every real
    submission — which is exactly how a run flagged nobody while sixteen
    candidates worked at the submitting institutions.
    """
    line = "the School of Electrical Engineering, Southeast University, Nanjing 210096, China"
    person = make_person(person_id="p-se")
    add_affiliation(person, "Southeast University")

    verdict = coi.evaluate(conn, person, context(author_institutions=[line]), policy)
    assert any(f.rule == "same_institution" for f in verdict.findings)


def test_a_department_named_in_the_affiliation_line_blocks(conn, policy):
    line = "College of Automation Engineering, Nanjing University of Aeronautics and Astronautics"
    person = make_person(person_id="p-dept")
    add_affiliation(
        person,
        "Nanjing University of Aeronautics and Astronautics",
        department="College of Automation Engineering",
    )

    verdict = coi.evaluate(conn, person, context(author_institutions=[line]), policy)
    assert verdict.blocked
    assert any(f.rule == "same_department" for f in verdict.findings)


def test_a_longer_institution_name_is_not_the_same_institution(conn, policy):
    """Matching on substrings would make every Nanjing university one place."""
    line = "Nanjing University of Aeronautics and Astronautics, Nanjing 211106, China"
    person = make_person(person_id="p-nju")
    add_affiliation(person, "Nanjing University")

    verdict = coi.evaluate(conn, person, context(author_institutions=[line]), policy)
    assert verdict.status == coi.CLEAR


def test_a_country_in_the_affiliation_line_is_not_an_institution(conn, policy):
    person = make_person(person_id="p-cn")
    add_affiliation(person, "China")

    verdict = coi.evaluate(
        conn, person, context(author_institutions=["Southeast University, Nanjing, China"]), policy
    )
    assert verdict.status == coi.CLEAR


def test_an_orcid_identifies_a_submitting_author(conn):
    author = Author(name="Lingyun Shao", idx=0, orcid="0000-0002-6072-0849")
    paper = Paper.build(title="Some work", source="openalex", doi="10.1/x", year=2024)
    paper.authors = [author]
    repo.ingest_paper(conn, paper)

    identities = coi.identify_authors(conn, [("Lingyun Shao", "0000-0002-6072-0849")])
    assert [(i.name, i.how) for i in identities] == [("Lingyun Shao", "orcid")]
    assert all(i.certain for i in identities)


def test_a_name_only_match_is_reported_but_does_not_block(conn, policy):
    """Homonyms are the reason this is not a BLOCK.

    Three different people publish as "Wei Hua". Blocking a candidate because
    somebody with the submitting author's name once co-authored with them would
    remove a legitimate reviewer on no evidence; hiding it would drop the most
    common conflict there is. So it is put in front of the editor.
    """
    cand_id, author_id = _coauthored(conn, 2024)
    person = make_person(person_id=cand_id)

    verdict = coi.evaluate(
        conn, person, context(possible_author_person_ids=[author_id]), policy
    )
    assert not verdict.blocked
    assert verdict.status == coi.REVIEW
    finding = next(f for f in verdict.findings if f.rule == "possible_recent_coauthor")
    assert finding.evidence["identified_by"] == "name"


def test_an_identified_author_still_blocks(conn, policy):
    cand_id, author_id = _coauthored(conn, 2024)
    person = make_person(person_id=cand_id)
    verdict = coi.evaluate(conn, person, context(author_person_ids=[author_id]), policy)
    assert verdict.blocked


def test_a_homonym_of_an_identified_author_is_not_guessed_at_again(conn):
    """An ORCID settles the identity; other people of that name are not the author."""
    known = Author(name="Wei Hua", idx=0, orcid="0000-0001-0000-0001", openalex_id="A-1")
    paper = Paper.build(title="Known work", source="openalex", doi="10.1/k", year=2024)
    paper.authors = [known]
    repo.ingest_paper(conn, paper)

    other = Author(name="Wei Hua", idx=0, openalex_id="A-2")
    second = Paper.build(title="Different Wei Hua", source="openalex", doi="10.1/o", year=2024)
    second.authors = [other]
    repo.ingest_paper(conn, second)

    identities = coi.identify_authors(conn, [("Wei Hua", "0000-0001-0000-0001")])
    assert [i.how for i in identities] == ["orcid"]


# ------------------------------------------------- journal overlays ----


def test_no_journal_overlay_quietly_loosens_a_conflict_window():
    """A journal file may tighten the shared policy; loosening needs a reason.

    Narrowing the co-authorship window makes that journal *more* permissive
    than the default — a collaborator just outside the shorter window passes
    unflagged. TTE carried `coauthor_years = 4` with nothing to say why, so
    every run under it applied a weaker conflict rule than every other journal.
    A narrower window can still be right; it has to be stated here, next to the
    reason, rather than appearing in a config file nobody re-reads.
    """
    default = load_policy()
    deliberately_narrower: dict[str, int] = {}  # journal -> window, with the reason in review

    for path in sorted((Path(__file__).parents[1] / "configs" / "journals").glob("*.toml")):
        journal = path.stem
        window = load_policy(journal).coauthor_years
        expected = deliberately_narrower.get(journal, default.coauthor_years)
        assert window >= expected, (
            f"{journal}.toml narrows the co-authorship window to {window} years "
            f"(default {default.coauthor_years}); add it to this test with a reason"
        )
