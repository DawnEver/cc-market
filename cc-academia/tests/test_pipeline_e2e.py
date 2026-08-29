"""End-to-end: manuscript metadata in, evidenced shortlist out.

Runs the whole rev-disc pipeline through the CLI with the source layer stubbed,
so it exercises the real workspace, database, COI engine, ranking and renderer
without touching the network.
"""

from __future__ import annotations

import json

import pytest

from academia.cli import dispatch
from academia.core.models import Author, Paper
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
    expert = Author(name="Grace Expert", idx=0, position="first", openalex_id="A-expert")
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


def test_full_pipeline_produces_an_evidenced_shortlist(tmp_path, stub_sources, capsys):
    assert run(
        "init",
        "--slug", "tie-demo",
        "--title", "Torque ripple suppression in PMSM drives for traction",
        "--abstract", "We propose a torque ripple suppression method for PMSM traction drives.",
        "--keywords", "Torque ripple,Electric Motor Design",
        "--journal", "tie",
        "--year", "2026",
    ) == 0

    assert run("profile", "--slug", "tie-demo") == 0
    assert run("search", "--slug", "tie-demo") == 0
    assert run("candidates", "--slug", "tie-demo") == 0
    assert run("coi", "--slug", "tie-demo") == 0
    assert run("report", "--slug", "tie-demo", "--json") == 0

    payload = json.loads(capsys.readouterr().out)
    shortlist = tmp_path / "workspaces" / "reviewer-discovery" / "ongoing" / "tie-demo" / "5-shortlist" / "shortlist.md"
    assert shortlist.exists()

    text = shortlist.read_text(encoding="utf-8")
    assert "Grace Expert" in text
    assert "no detected conflict" in text
    assert payload["candidates"] >= 1


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


def test_an_unknown_journal_stops_the_run(stub_sources):
    run("init", "--slug", "tie-demo", "--title", "A study", "--journal", "nope")
    run("profile", "--slug", "tie-demo")
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
