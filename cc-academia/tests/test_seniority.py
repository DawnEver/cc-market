"""Academic rank: professor, lecturer, postdoc, or student.

An editor cannot invite an MSc student to review for IEEE Transactions, and the
candidate pool is built from authorship — which includes every student who ever
appeared on a paper. Rank is therefore not decoration; it is the difference
between a usable shortlist and one that has to be checked by hand.

Like everything else here it is *found*, never inferred: a rank comes from an
ORCID employment record or from a page that states it, and "unknown" stays
unknown rather than being guessed from a publication count.
"""

from __future__ import annotations

import pytest

from academia.reviewer import seniority


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Professor", "professor"),
        ("Full Professor of Electrical Engineering", "professor"),
        ("Distinguished University Professor", "professor"),
        ("Chair Professor", "professor"),
        ("Associate Professor", "associate_professor"),
        ("Assoc. Prof.", "associate_professor"),
        ("Assistant Professor", "assistant_professor"),
        ("Asst Professor", "assistant_professor"),
        ("Senior Lecturer", "senior_lecturer"),
        ("Lecturer in Power Electronics", "lecturer"),
        ("Postdoctoral Research Fellow", "postdoc"),
        ("Post-doc", "postdoc"),
        ("PhD Student", "phd_student"),
        ("Doctoral Candidate", "phd_student"),
        ("Ph.D. candidate in electrical engineering", "phd_student"),
        ("MSc Student", "msc_student"),
        ("Master's student", "msc_student"),
        ("Research Scientist", "researcher"),
        ("Senior Engineer", "engineer"),
        ("", "unknown"),
        ("Head of Department", "unknown"),
    ],
)
def test_titles_are_normalised_to_a_rank(text, expected):
    assert seniority.rank_from_title(text) == expected


def test_assistant_and_associate_are_not_swallowed_by_professor():
    """Matching "professor" first would promote every junior academic."""
    assert seniority.rank_from_title("Associate Professor") != "professor"
    assert seniority.rank_from_title("Assistant Professor") != "professor"


def test_students_are_identified_as_such():
    assert seniority.is_student("phd_student")
    assert seniority.is_student("msc_student")
    assert not seniority.is_student("postdoc")
    assert not seniority.is_student("professor")
    assert not seniority.is_student("unknown")


def test_ranks_are_ordered_by_seniority():
    assert seniority.seniority_of("professor") > seniority.seniority_of("associate_professor")
    assert seniority.seniority_of("associate_professor") > seniority.seniority_of("postdoc")
    assert seniority.seniority_of("postdoc") > seniority.seniority_of("phd_student")
    assert seniority.seniority_of("unknown") == 0


def test_the_most_senior_stated_rank_wins():
    """A career history holds every post someone ever held."""
    assert seniority.best_rank(["phd_student", "postdoc", "associate_professor"]) == (
        "associate_professor"
    )
    assert seniority.best_rank(["unknown", "unknown"]) == "unknown"
    assert seniority.best_rank([]) == "unknown"



# --------------------------------------------------------- end to end


def test_an_orcid_role_title_reaches_the_store(tmp_path):
    """`role-title` was parsed from ORCID and then dropped on the way in.

    store_institution_for had no role parameter, so every one of 752 stored
    affiliations carried an empty role and rank was unavailable for anybody.
    """
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "s.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Ada Prof", idx=0, openalex_id="A1"))
        repo.store_institution_for(
            conn,
            person_id,
            name="University of Kentucky",
            country_code="US",
            role="Associate Professor",
            is_current=True,
            source="orcid",
        )
        person = repo.load_person(conn, person_id)
        assert person is not None
        assert person.affiliations[0].role == "Associate Professor"
        assert person.rank == "associate_professor"
    finally:
        conn.close()


def test_rank_is_unknown_without_any_stated_role(tmp_path):
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "s2.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Bo Quiet", idx=0, openalex_id="A2"))
        repo.store_institution_for(
            conn, person_id, name="Somewhere", country_code="US", is_current=True
        )
        person = repo.load_person(conn, person_id)
        assert person.rank == "unknown"
    finally:
        conn.close()



def test_a_supplied_rank_overrides_whatever_the_career_record_says(tmp_path):
    """A rank supplied with its source was read off a page by someone.

    It is authoritative precisely because it is not inferred, so it must not
    have to out-rank an ORCID entry to be believed. A live run reported a PhD
    candidate as "Engineer" because his only ORCID employment was an industry
    post and that scored higher.
    """
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "s4.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Ada Chair", idx=0, openalex_id="A4"))
        repo.store_institution_for(
            conn, person_id, name="Spinoff", role="VP Engineering", is_current=True
        )
        repo.set_stated_rank(
            conn, person_id, "phd_student", source_url="https://lab.edu/people"
        )
        person = repo.load_person(conn, person_id)
        assert person.rank == "phd_student"
    finally:
        conn.close()


def test_the_shortlist_shows_the_academic_position(tmp_path):
    from academia.core.models import Person
    from academia.reviewer import rank as rank_module
    from academia.reviewer import report as report_module

    person = Person(person_id="p1", display_name="Ada Prof", stated_rank="associate_professor")
    candidate = rank_module.Candidate(person=person)
    rows = report_module.build_rows([candidate])

    assert "position" in report_module.EXPORT_COLUMNS
    assert "Associate Professor" in rows[0].as_list()


def test_a_student_is_flagged_for_the_editor(tmp_path):
    """The pool is built from authorship, so it contains students by construction."""
    from academia.core.models import Person
    from academia.reviewer import rank as rank_module
    from academia.reviewer.policy import load_policy
    from academia.store import db

    conn = db.connect(tmp_path / "n.db")
    try:
        person = Person(person_id="p1", display_name="Junior One", stated_rank="msc_student")
        candidate = rank_module.Candidate(person=person)
        scored = rank_module.score_candidate(
            conn,
            candidate,
            profile_topics=["axial flux"],
            profile_methods=[],
            policy=load_policy(),
            now_year=2026,
        )
        assert any("MSc student" in note for note in scored.notes)
    finally:
        conn.close()


def test_a_role_is_not_lost_when_openalex_wrote_the_affiliation_first(tmp_path):
    """OpenAlex has no roles; ORCID has them and arrives second.

    The upsert updated department and source_url but not role, so the ORCID
    role hit the conflict clause and was silently dropped — 0 of 752 stored
    affiliations carried one.
    """
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "s5.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Ada Prof", idx=0, openalex_id="A5"))
        repo.store_institution_for(
            conn, person_id, name="Uni", year_from=2015, is_current=True, source="openalex"
        )
        repo.store_institution_for(
            conn,
            person_id,
            name="Uni",
            role="Professor",
            year_from=2015,
            is_current=True,
            source="orcid",
        )
        person = repo.load_person(conn, person_id)
        assert person.rank == "professor"
    finally:
        conn.close()




def test_a_stated_title_is_shown_even_when_it_maps_to_no_standard_rank(tmp_path):
    """"Research Assistant" is a real answer; reporting it as unknown loses it.

    Unknown should mean nobody stated anything, not that the classifier had no
    bucket for what they stated.
    """
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "t.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Ada RA", idx=0, openalex_id="A6"))
        repo.store_institution_for(
            conn, person_id, name="Uni", role="Research Assistant", is_current=True
        )
        person = repo.load_person(conn, person_id)
        assert person.rank == "unknown"
        assert person.stated_title == "Research Assistant"
    finally:
        conn.close()


@pytest.mark.parametrize("junk", ["无", "n/a", "-", "none", "  "])
def test_placeholder_titles_are_not_treated_as_a_position(junk):
    assert seniority.clean_title(junk) == ""


def test_a_real_title_survives_cleaning():
    assert seniority.clean_title(" Research Assistant ") == "Research Assistant"


def test_an_academic_role_outranks_an_industry_one(tmp_path):
    """Many academics also hold a company post; ORCID lists both.

    Reporting an associate professor as "Engineer" because their spin-off is
    also in the record tells an editor the opposite of what they need.
    """
    from academia.core.models import Author
    from academia.store import db
    from academia.store import repository as repo

    conn = db.connect(tmp_path / "u.db")
    try:
        person_id = repo.upsert_person(conn, Author(name="Ada Both", idx=0, openalex_id="A7"))
        repo.store_institution_for(
            conn,
            person_id,
            name="Spinoff Inc",
            role="VP Engineering",
            kind="company",
            year_from=2018,
            is_current=True,
        )
        repo.store_institution_for(
            conn,
            person_id,
            name="McMaster University",
            role="Associate Professor",
            kind="education",
            year_from=2016,
            is_current=True,
        )
        person = repo.load_person(conn, person_id)
        assert person.rank == "associate_professor"
        assert person.stated_title == "Associate Professor"
    finally:
        conn.close()
