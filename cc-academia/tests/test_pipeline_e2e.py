"""End-to-end: manuscript metadata in, evidenced shortlist out.

Runs the whole rev-disc pipeline through the CLI with the source layer stubbed,
so it exercises the real workspace, database, COI engine, ranking and renderer
without touching the network.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from academia.cli import dispatch
from academia.core.models import Author, Paper
from academia.reviewer.workspace import STAGES, open_workspace
from academia.sources.base import SearchPage


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ACADEMIA_DATA_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("ACADEMIA_DB", str(tmp_path / "data" / "academia.db"))
    monkeypatch.delenv("ACADEMIA_CONFIG_DIR", raising=False)


class StubSource:
    """A source returning a fixed corpus: one clear expert, one co-author."""

    name = "openalex"
    request_delay = 0.0
    max_retries = 1

    def __init__(self):
        self.calls = 0

    def adapt_expression(self, expression):
        return expression

    def search_pages(self, expression, query_id, *, max_pages=1, per_page=25, **kwargs):
        self.calls += 1
        if self.calls > 1:
            return [SearchPage(self.name, query_id, 1, 0, [])]
        return [SearchPage(self.name, query_id, 1, len(_corpus()), _corpus())]


def _paper(doi, title, authors, year=2025):
    paper = Paper.build(
        title=title,
        source="openalex",
        doi=doi,
        abstract="Torque ripple suppression for permanent magnet synchronous motor drives.",
        year=year,
        venue="IEEE TIE",
    )
    paper.authors = authors
    paper.terms = [("Torque ripple", "keyword", 0.9), ("Electric Motor Design", "topic", 0.8)]
    return paper


def _corpus():
    expert = Author(name="Gökhan Çakal", idx=0, position="first", openalex_id="A-expert")
    junior = Author(name="Ravi Junior", idx=1, position="last", openalex_id="A-junior")
    submitter = Author(name="Alice Author", idx=0, position="first", openalex_id="A-alice")
    collaborator = Author(name="Bob Collaborator", idx=1, position="last", openalex_id="A-bob")
    return [
        _paper("10.1109/a", "Torque ripple suppression in PMSM drives", [expert, junior]),
        _paper("10.1109/b", "Torque ripple analysis for traction motors", [expert]),
        _paper("10.1109/c", "Torque ripple and recent joint work", [submitter, collaborator], year=2024),
    ]


@pytest.fixture()
def stub_sources(monkeypatch):
    source = StubSource()
    monkeypatch.setattr("academia.cli.rev_disc._sources", lambda names: [source])
    return source


def run(*argv) -> int:
    return dispatch.rev_disc_main(list(argv))


def test_reviewer_search_registry_includes_semantic_scholar():
    from academia.cli import rev_disc

    assert [source.name for source in rev_disc._sources(None)] == [
        "openalex",
        "ieee",
        "semantic_scholar",
    ]


def test_unknown_reviewer_search_source_is_a_usage_error():
    from academia.cli import rev_disc
    from academia.core.errors import UsageError

    with pytest.raises(UsageError, match="unknown source"):
        rev_disc._sources(["not-a-source"])


def test_full_pipeline_produces_an_evidenced_shortlist(tmp_path, stub_sources, capsys):
    assert run(
        "init",
        "--slug", "tie-demo",
        "--title", "Torque ripple suppression in PMSM drives for traction",
        "--abstract", "We propose a torque ripple suppression method for PMSM traction drives.",
        "--keywords", "Torque ripple,Electric Motor Design",
        "--journal", "tie",
        "--year", "2026",
        "--authors", "Alice Author|Tsinghua University|CN; Bob Second|Tsinghua University|CN",
    ) == 0

    assert run("profile", "--slug", "tie-demo") == 0
    assert run("profile", "--slug", "tie-demo", "--approve") == 0
    assert run("search", "--slug", "tie-demo") == 0
    assert run("candidates", "--slug", "tie-demo") == 0
    assert run("contacts", "--slug", "tie-demo", "--json") == 0
    contacts = json.loads(capsys.readouterr().out)
    assert any(person["name"] == "Gökhan Çakal" for person in contacts["candidates"])
    assert run("coi", "--slug", "tie-demo") == 0
    assert run("report", "--slug", "tie-demo", "--json") == 0

    payload = json.loads(capsys.readouterr().out)
    shortlist = tmp_path / "workspaces" / "reviewer-discovery" / "ongoing" / "tie-demo" / "5-shortlist" / "shortlist.md"
    assert shortlist.exists()

    text = shortlist.read_text(encoding="utf-8")
    assert "Gökhan Çakal" in text
    assert "no detected conflict" in text
    assert payload["candidates"] >= 1

    csv_path = shortlist.with_suffix(".csv")
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        exported = list(csv.DictReader(handle))
    markdown_header = next(line for line in text.splitlines() if line.startswith("| rank |"))
    markdown_columns = [cell.strip() for cell in markdown_header.strip("|").split("|")]
    assert markdown_columns == list(exported[0])
    assert exported[0]["person_id"]
    assert float(exported[0]["identity_confidence"]) >= 0
    assert "evidence_json" not in exported[0]
    assert "evidence_titles" not in exported[0]
    for name in ("institutions", "education", "evidence", "coi_findings", "invitations"):
        detail_path = Path(payload[name])
        assert detail_path.exists()
        with detail_path.open(encoding="utf-8-sig", newline="") as handle:
            header = next(csv.reader(handle))
        assert header[:3] == ["rank", "reviewer", "person_id"]


def test_the_raw_pdf_is_never_required_and_body_text_never_stored(tmp_path, stub_sources):
    run("init", "--slug", "tie-demo", "--title", "A study", "--abstract", "Body.", "--journal", "tie")
    run("profile", "--slug", "tie-demo")

    from academia.store import db

    with db.session() as conn:
        row = conn.execute("SELECT * FROM manuscripts").fetchone()
        assert set(row.keys()) == {"ms_id", "journal", "title_hash", "origin_countries", "created_at"}
        assert "A study" not in json.dumps(dict(row))


def test_a_manuscript_author_is_blocked_end_to_end(tmp_path, stub_sources, capsys):
    workspace_root = tmp_path / "workspaces" / "reviewer-discovery" / "ongoing" / "tie-demo"
    run(
        "init", "--slug", "tie-demo",
        "--title", "Torque ripple suppression in PMSM drives",
        "--abstract", "Torque ripple suppression for PMSM traction drives.",
        "--keywords", "Torque ripple",
        "--journal", "tie", "--year", "2026",
    )
    run("profile", "--slug", "tie-demo")

    # Declare the submitting author, then re-profile so the store learns them.
    sanitized_path = workspace_root / "1-manuscript" / "sanitized.json"
    data = json.loads(sanitized_path.read_text(encoding="utf-8"))
    data["authors"] = [{"name": "Alice Author", "affiliation": "Some University", "country": "CN"}]
    sanitized_path.write_text(json.dumps(data), encoding="utf-8")

    run("profile", "--slug", "tie-demo")
    run("profile", "--slug", "tie-demo", "--approve")
    run("search", "--slug", "tie-demo")
    run("candidates", "--slug", "tie-demo")
    capsys.readouterr()
    assert run("coi", "--slug", "tie-demo", "--json") == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["counts"]["BLOCK"] >= 1

    verdicts = [
        json.loads(line)
        for line in (workspace_root / "4-audit" / "coi.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    blocked = [v for v in verdicts if v["status"] == "BLOCK"]
    assert any(v["name"] == "Alice Author" for v in blocked)


def test_status_reports_the_next_stage(stub_sources, capsys):
    run("init", "--slug", "tie-demo", "--title", "A study", "--journal", "tie")
    capsys.readouterr()
    assert run("status", "--slug", "tie-demo", "--json") == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["next_stage"] == "profile"


def test_lookup_attempts_make_unsearched_candidates_visible_in_report(
    tmp_path, stub_sources, capsys, monkeypatch
):
    monkeypatch.setattr("academia.reviewer.enrich.enrich", lambda conn, person: person)
    run(
        "init", "--slug", "tie-lookups", "--title", "Torque ripple suppression",
        "--abstract", "Torque ripple suppression for PMSM traction drives.",
        "--keywords", "Torque ripple", "--journal", "tie", "--year", "2026",
        "--authors", "Alice Author|Tsinghua University|CN",
    )
    run("profile", "--slug", "tie-lookups")
    run("profile", "--slug", "tie-lookups", "--approve")
    run("search", "--slug", "tie-lookups")
    run("candidates", "--slug", "tie-lookups")
    capsys.readouterr()
    run("contacts", "--slug", "tie-lookups", "--json")
    initial = json.loads(capsys.readouterr().out)
    searched_ids = [item["person_id"] for item in initial["candidates"][:2]]
    answers = tmp_path / "lookups.json"
    answers.write_text(
        json.dumps(
            {
                person_id: {
                    "queries": [f"{person_id} faculty profile"],
                    "urls_seen": [],
                    "urls": [],
                    "outcome": "no_public_data",
                }
                for person_id in searched_ids
            }
        ),
        encoding="utf-8",
    )

    run("enrich", "--slug", "tie-lookups", "--no-email", "--homepages", str(answers))
    run("contacts", "--slug", "tie-lookups", "--json")
    contacts = json.loads(capsys.readouterr().out)
    assert contacts["never_searched"] == contacts["missing"] - 2
    searched = {item["person_id"]: item for item in contacts["candidates"]}
    assert all(searched[person_id]["last_outcome"] == "no_public_data" for person_id in searched_ids)

    assert run("coi", "--slug", "tie-lookups") == 0
    assert run("report", "--slug", "tie-lookups", "--json") == 0
    report_payload = json.loads(capsys.readouterr().out)
    assert report_payload["lookup_coverage"]["never_searched"] == contacts["never_searched"]
    coverage = json.loads(Path(report_payload["lookup_coverage_file"]).read_text(encoding="utf-8"))
    assert coverage == report_payload["lookup_coverage"]


def test_completed_status_does_not_tell_the_user_to_repeat_report(stub_sources, capsys):
    run("init", "--slug", "tie-demo", "--title", "A study", "--journal", "tie")
    workspace = open_workspace("tie-demo")
    state = workspace.load_state()
    for stage in STAGES:
        state.mark(stage)
    workspace.save_state(state)

    capsys.readouterr()
    assert run("status", "--slug", "tie-demo", "--json") == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["next_stage"] == "complete"


def test_an_unknown_journal_stops_the_run(stub_sources):
    run("init", "--slug", "tie-demo", "--title", "A study", "--journal", "nope")
    run("profile", "--slug", "tie-demo")
    run("profile", "--slug", "tie-demo", "--approve")
    run("search", "--slug", "tie-demo")
    run("candidates", "--slug", "tie-demo")
    assert run("coi", "--slug", "tie-demo") == 2


def test_missing_workspace_is_a_usage_error(stub_sources):
    assert run("profile", "--slug", "never-created") == 2


def test_candidates_are_written_in_evidence_order(tmp_path, stub_sources):
    """Everything downstream slices this list with --limit.

    Unordered, `enrich --limit 40` on a 200-candidate pool could miss every
    top-ranked person — which is exactly what a live run showed.
    """
    run("init", "--slug", "tie-demo", "--title", "Torque ripple suppression in PMSM drives",
        "--abstract", "Torque ripple suppression for PMSM traction drives.",
        "--keywords", "Torque ripple", "--journal", "tie", "--year", "2026")
    run("profile", "--slug", "tie-demo")
    run("profile", "--slug", "tie-demo", "--approve")
    run("search", "--slug", "tie-demo")
    run("candidates", "--slug", "tie-demo")

    path = tmp_path / "workspaces" / "reviewer-discovery" / "ongoing" / "tie-demo" / "3-candidates" / "candidates.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(rows) >= 2

    def strength(row):
        return sum(e["similarity"] * e["position_weight"] for e in row["evidence"])

    scores = [strength(r) for r in rows]
    assert scores == sorted(scores, reverse=True)


def test_rerunning_report_does_not_leave_a_stale_dossier(tmp_path, stub_sources):
    """Rank prefixes change between runs; a leftover file reads as a real entry.

    The dossier filename carries the rank, so re-running `report` after tuning
    the profile wrote a second file for the same person under a new prefix and
    left the old one beside it. An editor opening the directory cannot tell
    which run a file came from.
    """
    from academia.reviewer import report as report_module
    from academia.reviewer.profile import Profile
    from academia.store import db

    directory = tmp_path / "5-shortlist"
    (directory / "dossiers").mkdir(parents=True)
    stale = directory / "dossiers" / "07-person-old.md"
    stale.write_text("from an earlier run", encoding="utf-8")

    with db.session(tmp_path / "e.db") as conn:
        report_module.write_all(
            conn,
            directory,
            [],
            Profile(manuscript_id="ms-1", title_hash="h", journal="tte", year=2026),
            ["coi.toml"],
        )

    assert not stale.exists()


def _init_and_profile(slug):
    run(
        "init", "--slug", slug, "--journal", "tie", "--title", "Torque Ripple In Machines",
        "--abstract", "A study of torque ripple.", "--keywords", "torque ripple,machines",
    )
    run("profile", "--slug", slug)


def test_search_refuses_until_the_queries_have_been_reviewed(tmp_path, stub_sources, capsys):
    """Bad queries mean the right reviewers never enter the pool, and nothing
    downstream can recover them. It is the one step a human has to see."""
    _init_and_profile("gate")

    assert run("search", "--slug", "gate") == 2
    assert "not been reviewed" in capsys.readouterr().err


def test_search_proceeds_once_the_queries_are_approved(tmp_path, stub_sources):
    _init_and_profile("gate2")
    assert run("profile", "--slug", "gate2", "--approve") == 0
    assert run("search", "--slug", "gate2", "--source", "openalex") == 0


def test_editing_the_queries_after_approval_re_arms_the_gate(tmp_path, stub_sources, capsys):
    """Approval binds to what was approved, not to the act of approving."""
    from academia.reviewer.workspace import open_workspace

    _init_and_profile("gate3")
    run("profile", "--slug", "gate3", "--approve")

    workspace = open_workspace("gate3")
    profile = json.loads(workspace.profile_path.read_text(encoding="utf-8"))
    profile["queries"].append(
        {"query_id": "qX", "expression": '"something else"', "rationale": "added by hand"}
    )
    workspace.profile_path.write_text(json.dumps(profile), encoding="utf-8")

    assert run("search", "--slug", "gate3") == 2
    assert "changed since" in capsys.readouterr().err


def test_coi_refuses_when_no_submitting_authors_are_declared(tmp_path, stub_sources, capsys):
    """Every conflict rule that matters keys off the author list.

    With it empty the engine reports "no detected conflict" for the submitting
    authors themselves — a confident, wrong Clear on exactly the people who must
    never review. Refusing is the only safe answer.
    """
    run("init", "--slug", "noauth", "--journal", "tie", "--title", "A Study Of Things")
    run("profile", "--slug", "noauth")
    run("profile", "--slug", "noauth", "--approve")
    run("search", "--slug", "noauth", "--source", "openalex")
    run("candidates", "--slug", "noauth")

    assert run("coi", "--slug", "noauth") == 2
    assert "submitting author" in capsys.readouterr().err


def test_a_second_workspace_for_the_same_manuscript_is_refused(tmp_path, stub_sources, capsys):
    """One manuscript, one workspace.

    Two workspaces for one submission means two candidate pools, two COI runs
    and two shortlists that can disagree, with nothing to say which is current.
    The manuscript's identity is its title hash, so the collision is detectable
    rather than a matter of naming discipline.
    """
    run("init", "--slug", "first", "--journal", "tie", "--title", "One Paper About Machines")

    assert run("init", "--slug", "second", "--journal", "tie",
               "--title", "One Paper About Machines") == 2
    err = capsys.readouterr().err
    assert "already has a workspace" in err
    assert "first" in err


def test_re_initialising_the_same_slug_is_still_allowed(tmp_path, stub_sources):
    """Re-running init on its own workspace is how a bad extraction is fixed."""
    run("init", "--slug", "again", "--journal", "tie", "--title", "One Paper About Machines")

    assert run("init", "--slug", "again", "--journal", "tie",
               "--title", "One Paper About Machines") == 0


def test_a_refused_init_leaves_no_workspace_behind(tmp_path, stub_sources):
    """Refusing must not half-create the thing it refused to create."""
    from academia.core import paths

    run("init", "--slug", "keeper", "--journal", "tie", "--title", "One Paper About Machines")
    run("init", "--slug", "leftover", "--journal", "tie", "--title", "One Paper About Machines")

    assert not (paths.ongoing_root("reviewer-discovery") / "leftover").exists()


def test_coi_survives_a_workspace_that_arrived_from_another_machine(tmp_path, stub_sources):
    """The workspace syncs; the database deliberately does not.

    ``run_state.json`` records which stages are done, and it travels in the
    synced folder along with the rest of the workspace. The rows those stages
    wrote live in SQLite, which stays on the machine that wrote them because
    WAL mode and a file-level syncer corrupt each other. So on the second
    machine every stage reads as complete while the database is empty, and
    ``coi`` used to die on a foreign key pointing at a manuscript nobody had
    inserted here.

    Each command has to be able to rebuild what it needs from the workspace it
    was handed.
    """
    import sqlite3

    from academia.core import paths

    for argv in (
        ("init", "--slug", "tie-moved",
         "--title", "Torque ripple suppression in PMSM drives for traction",
         "--abstract", "We propose a torque ripple suppression method for PMSM traction drives.",
         "--keywords", "Torque ripple,Electric Motor Design",
         "--journal", "tie", "--year", "2026",
         "--authors", "Alice Author|Tsinghua University|CN"),
        ("profile", "--slug", "tie-moved"),
        ("profile", "--slug", "tie-moved", "--approve"),
        ("search", "--slug", "tie-moved"),
        ("candidates", "--slug", "tie-moved"),
    ):
        assert run(*argv) == 0

    # The other machine's database never arrives. Only the workspace does.
    connection = sqlite3.connect(paths.database_path())
    connection.execute("DELETE FROM manuscripts")
    connection.commit()
    connection.close()

    assert run("coi", "--slug", "tie-moved") == 0


def test_the_shortlist_shows_a_second_address_when_one_was_found(tmp_path, stub_sources):
    """Both addresses reach the editor, with where each came from.

    Precedence still decides which is offered first, but a candidate who has
    moved has a footnote address and a current staff-page address and only the
    editor can tell which one to write to. Dropping the runner-up from the
    report hides that the choice exists.
    """
    import csv

    from academia.core import paths
    from academia.reviewer.workspace import open_workspace
    from academia.store import db
    from academia.store import repository as repo

    for argv in (
        ("init", "--slug", "tie-two-addresses",
         "--title", "Torque ripple suppression in PMSM drives for traction",
         "--abstract", "We propose a torque ripple suppression method for PMSM traction drives.",
         "--keywords", "Torque ripple,Electric Motor Design",
         "--journal", "tie", "--year", "2026",
         "--authors", "Alice Author|Tsinghua University|CN"),
        ("profile", "--slug", "tie-two-addresses"),
        ("profile", "--slug", "tie-two-addresses", "--approve"),
        ("search", "--slug", "tie-two-addresses"),
        ("candidates", "--slug", "tie-two-addresses"),
        ("coi", "--slug", "tie-two-addresses"),
    ):
        assert run(*argv) == 0

    workspace = open_workspace("tie-two-addresses")
    rows = workspace.read_jsonl(workspace.candidate_dir / "candidates.jsonl")
    person_id = rows[0]["person_id"]

    connection = db.connect(paths.database_path())
    repo.record_email(
        connection, person_id, "old.address@previous.edu",
        source="published_corresponding", source_url="https://doi.example/paper",
        confidence=0.95,
    )
    repo.record_email(
        connection, person_id, "current.address@now.edu",
        source="institutional_profile", source_url="https://now.edu/staff/x",
        confidence=0.9,
    )
    connection.commit()
    connection.close()

    # What enrich would have written: the address that won on precedence.
    workspace.write_jsonl(
        workspace.audit_dir / "enrichment.jsonl",
        [{
            "person_id": person_id,
            "name": rows[0].get("name", ""),
            "email": {
                "email": "old.address@previous.edu",
                "source": "published_corresponding",
                "source_url": "https://doi.example/paper",
                "confidence": 0.95,
            },
        }],
    )

    assert run("report", "--slug", "tie-two-addresses") == 0

    csv_path = workspace.shortlist_dir / "shortlist.csv"
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        exported = {row["person_id"]: row for row in csv.DictReader(handle)}

    row = exported[person_id]
    assert row["email"] == "old.address@previous.edu"
    assert row["email_alternate"] == "current.address@now.edu"
    assert row["email_alternate_source"] == "institutional_profile"
    assert row["email_alternate_source_url"] == "https://now.edu/staff/x"


def test_candidates_says_so_when_the_papers_are_on_the_other_machine(tmp_path, stub_sources, capsys):
    """Zero candidates from 277 stored papers is a broken machine, not a result.

    ``search`` writes papers to the workspace, which syncs, and to the database,
    which does not. On the second machine ``run_state.json`` says search is done
    while the papers table is empty, so ``candidates`` scores nothing and
    cheerfully reports no candidates — indistinguishable from a search that
    genuinely found nobody. It has to name the cause and the cure instead.
    """
    import sqlite3

    from academia.core import paths

    for argv in (
        ("init", "--slug", "tie-no-papers",
         "--title", "Torque ripple suppression in PMSM drives for traction",
         "--abstract", "We propose a torque ripple suppression method for PMSM traction drives.",
         "--keywords", "Torque ripple,Electric Motor Design",
         "--journal", "tie", "--year", "2026",
         "--authors", "Alice Author|Tsinghua University|CN"),
        ("profile", "--slug", "tie-no-papers"),
        ("profile", "--slug", "tie-no-papers", "--approve"),
        ("search", "--slug", "tie-no-papers"),
    ):
        assert run(*argv) == 0

    # The other machine's database never arrives. Only the workspace does.
    connection = sqlite3.connect(paths.database_path())
    connection.execute("DELETE FROM papers")
    connection.commit()
    connection.close()

    capsys.readouterr()  # discard the earlier stages' output
    assert run("candidates", "--slug", "tie-no-papers") == 0

    warning = capsys.readouterr().err
    assert "no papers" in warning
    assert "rev-disc search" in warning
