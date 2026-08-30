"""Portable facts: the part of the store that has to survive a new machine.

The database is a cache and is deliberately not synced — SQLite in WAL mode and
a file-level syncer corrupt each other silently. What travels instead is the
handful of facts nobody can re-derive, as text, one directory per device so two
machines never write the same path.
"""

from __future__ import annotations

import json

import pytest

from academia.core.models import Author, Education, Institution
from academia.store import db, facts
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "a.db")
    yield connection
    connection.close()


@pytest.fixture()
def other(tmp_path):
    connection = db.connect(tmp_path / "b.db")
    yield connection
    connection.close()


def a_person(connection, *, name="Candidate", orcid="0000-0001-2345-6789") -> str:
    return repo.upsert_person(
        connection, Author(name=name, idx=0, orcid=orcid, openalex_id="A" + orcid[-4:])
    )


def with_facts(connection, person_id: str) -> None:
    repo.record_invitation(
        connection, person_id, "ms-1", invited_at="2026-01-01", responded=True, accepted=False
    )
    repo.set_stated_rank(
        connection, person_id, "professor", source_url="https://uni.example/staff/x"
    )
    repo.record_email(
        connection,
        person_id,
        email="x@uni.example",
        source="institutional_profile",
        source_url="https://uni.example/staff/x",
        confidence=0.9,
    )
    repo.store_institution_for(
        connection,
        person_id,
        name="University of Somewhere",
        country_code="GB",
        is_current=True,
        source="agent_lookup",
        source_url="https://uni.example/staff/x",
    )
    built = Institution.build(name="Doctorate Uni")
    repo.upsert_institution(connection, built)
    repo.record_education(
        connection,
        person_id,
        Education(
            inst_id=built.inst_id,
            institution="Doctorate Uni",
            degree="Ph.D.",
            year_from=2011,
            year_to=2015,
            source="agent_lookup",
            source_url="https://uni.example/staff/x",
        ),
    )


def test_a_second_machine_gains_every_non_derivable_fact(conn, other, tmp_path):
    person_id = a_person(conn)
    with_facts(conn, person_id)

    facts.export(conn, tmp_path / "shared")
    counts, skipped = facts.import_(other, tmp_path / "shared")

    assert skipped == 0
    assert counts == {
        "invitations": 1,
        "ranks": 1,
        "emails": 1,
        "affiliations": 1,
        "education": 1,
    }

    person = repo.load_person(other, person_id)
    assert person is not None
    assert person.rank == "professor"
    assert person.rank_source.endswith("/staff/x")
    assert person.country_code == "GB"
    assert person.phd_year == 2015
    assert repo.emails_of(other, person_id)[0]["email"] == "x@uni.example"
    assert len(repo.invitation_history(other, person_id)) == 1


def test_the_database_is_never_part_of_what_travels(conn, tmp_path):
    """Only text goes into the synced folder — no .db, no -wal, no -shm."""
    with_facts(conn, a_person(conn))
    facts.export(conn, tmp_path / "shared")

    written = sorted(p.name for p in (tmp_path / "shared").rglob("*") if p.is_file())
    assert all(name.endswith((".jsonl", ".txt")) for name in written), written


def test_only_verified_affiliations_travel(conn, tmp_path):
    """An OpenAlex affiliation comes back on its own; shipping it is noise."""
    person_id = a_person(conn)
    repo.store_institution_for(
        conn, person_id, name="Guessed University", country_code="CN", is_current=True,
        source="openalex", source_url="https://openalex.org/A1",
    )
    collected = facts.collect(conn)
    assert collected["affiliations"] == []


def test_re_exporting_unchanged_data_does_not_touch_the_files(conn, tmp_path):
    """A folder that churns every run is one the user turns sync off for."""
    with_facts(conn, a_person(conn))
    shared = tmp_path / "shared"
    facts.export(conn, shared)
    before = {p: p.read_bytes() for p in shared.rglob("*.jsonl")}
    mtimes = {p: p.stat().st_mtime_ns for p in before}

    facts.export(conn, shared)

    assert {p: p.read_bytes() for p in shared.rglob("*.jsonl")} == before
    assert {p: p.stat().st_mtime_ns for p in before} == mtimes


def test_importing_twice_changes_nothing_the_second_time(conn, other, tmp_path):
    person_id = a_person(conn)
    with_facts(conn, person_id)
    facts.export(conn, tmp_path / "shared")

    facts.import_(other, tmp_path / "shared")
    facts.import_(other, tmp_path / "shared")

    assert len(repo.invitation_history(other, person_id)) == 1
    assert len(repo.emails_of(other, person_id)) == 1


def test_a_conflicted_copy_is_read_rather_than_lost(conn, other, tmp_path):
    """A syncer that hits a real conflict renames; the facts must still merge."""
    person_id = a_person(conn)
    with_facts(conn, person_id)
    shared = tmp_path / "shared"
    facts.export(conn, shared)

    device_dir = next(p for p in shared.iterdir() if p.is_dir())
    conflicted = device_dir / "emails-DESKTOP-2.jsonl"
    record = json.loads((device_dir / "emails.jsonl").read_text(encoding="utf-8").splitlines()[0])
    record["email"] = "second@uni.example"
    conflicted.write_text(json.dumps(record) + "\n", encoding="utf-8")

    facts.import_(other, shared)

    assert {row["email"] for row in repo.emails_of(other, person_id)} == {
        "x@uni.example",
        "second@uni.example",
    }


def test_a_fact_about_an_unidentifiable_person_is_skipped_not_guessed(other, tmp_path):
    """Attaching an address to a namesake is worse than losing the address."""
    shared = tmp_path / "shared" / "device-a"
    shared.mkdir(parents=True)
    (shared / "emails.jsonl").write_text(
        json.dumps(
            {
                "person_id": "person-nameonly",
                "orcid": "",
                "openalex_id": "",
                "display_name": "Wei Liu",
                "email": "wei@uni.example",
                "source": "institutional_profile",
                "confidence": 0.9,
                "verified_at": "2026-01-01T00:00:00+00:00",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    counts, skipped = facts.import_(other, tmp_path / "shared")

    assert counts["emails"] == 0
    assert skipped == 1


def test_an_import_never_blanks_a_source_url(conn, other, tmp_path):
    """Importing an older export must not undo what this machine already knows."""
    person_id = a_person(conn)
    repo.record_email(
        conn, person_id, email="x@uni.example", source="orcid_public", source_url="", confidence=0.7
    )
    facts.export(conn, tmp_path / "shared")

    a_person(other)
    repo.record_email(
        other,
        person_id,
        email="x@uni.example",
        source="institutional_profile",
        source_url="https://uni.example/staff/x",
        confidence=0.9,
    )
    facts.import_(other, tmp_path / "shared")

    row = repo.emails_of(other, person_id)[0]
    assert row["source_url"] == "https://uni.example/staff/x"
    assert row["confidence"] == 0.9


def test_a_half_written_line_is_skipped_rather_than_fatal(other, tmp_path):
    """A file being synced can be read mid-write; that is not an error."""
    device = tmp_path / "shared" / "device-a"
    device.mkdir(parents=True)
    (device / "ranks.jsonl").write_text('{"person_id": "p", "ra', encoding="utf-8")

    counts, skipped = facts.import_(other, tmp_path / "shared")

    assert counts["ranks"] == 0
    assert skipped == 0


def test_an_empty_shared_folder_is_not_an_error(other, tmp_path):
    counts, skipped = facts.import_(other, tmp_path / "nothing-here")
    assert sum(counts.values()) == 0 and skipped == 0


def test_an_undated_affiliation_is_updated_not_duplicated(conn):
    """SQLite treats every NULL as distinct, so ON CONFLICT cannot see this one.

    Sharing facts between machines turned that into 458k rows for 23 people
    before it was caught: each import re-inserted, each export then carried the
    duplicates back out.
    """
    from academia.core.models import Affiliation

    person_id = a_person(conn)
    repo.upsert_institution(conn, Institution.build(name="Somewhere"))
    inst_id = Institution.build(name="Somewhere").inst_id
    for _ in range(5):
        repo.record_affiliation(
            conn,
            person_id,
            Affiliation(
                inst_id=inst_id,
                institution="Somewhere",
                is_current=True,
                source="agent_lookup",
                source_url="https://uni.example/staff/x",
            ),
        )

    rows = conn.execute(
        "SELECT count(*) AS n FROM affiliations WHERE person_id = ?", (person_id,)
    ).fetchone()
    assert rows["n"] == 1


def test_repeated_syncs_do_not_grow_the_store(conn, tmp_path):
    """The property that makes automatic sync safe to leave on."""
    person_id = a_person(conn)
    with_facts(conn, person_id)
    shared = tmp_path / "shared"

    sizes = []
    for _ in range(3):
        facts.sync(conn, shared)
        sizes.append(conn.execute("SELECT count(*) AS n FROM affiliations").fetchone()["n"])

    assert len(set(sizes)) == 1
