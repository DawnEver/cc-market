"""Coverage for the queue / match / manifest stage and its orchestrator wiring.

This module had zero tests, which is why the match-report path drifted out of
sync with the orchestrator and silently disabled manifest generation.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from academia.litreview.acquire import ledger
from academia.litreview.acquire.types import DownloadRecord, Outcome
from academia.litreview.acquire.verify import sha256_file
from academia.litreview.acquire_pipeline import (
    approve_download_queue,
    manifest_rows,
    match_manual_drop,
    validate_pdf,
    write_download_manifest,
    write_download_queue,
)

# A minimal but real PDF: header, one object, trailer. Must exceed MIN_PDF_BYTES.
PDF_BYTES = b"%PDF-1.4\n" + b"%padding\n" * 200 + b"trailer\n%%EOF\n"


def _screening_row(cid, decision="include", **extra):
    row = {
        "candidate_id": cid,
        "title": f"Paper {cid}",
        "decision": decision,
        "download_priority": "high",
        "doi": f"10.1000/{cid}",
        "html_url": f"https://example.org/{cid}",
        "pdf_url": "",
        "inclusion_reasons": ["relevant"],
        "exclusion_reasons": [],
        "uncertainties": [],
        "publication_year": 2024,
        "publication_title": "Journal of Testing",
    }
    row.update(extra)
    return row


@pytest.fixture
def workspace(tmp_path):
    (tmp_path / "screening").mkdir()
    return tmp_path


def _write_screening(workspace, rows):
    path = workspace / "screening" / "screening_stage1.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Queue construction
# ---------------------------------------------------------------------------

def test_queue_includes_include_and_maybe_decisions(workspace):
    screening = _write_screening(workspace, [
        _screening_row("a", "include"),
        _screening_row("b", "maybe"),
        _screening_row("c", "exclude"),
    ])
    write_download_queue(screening, workspace / "download")

    queue = json.loads((workspace / "download" / "download_queue.json").read_text(encoding="utf-8"))
    assert {i["candidate_id"] for i in queue["items"]} == {"a", "b"}


def test_queue_skips_download_priority_none(workspace):
    screening = _write_screening(workspace, [_screening_row("a", download_priority="none")])
    write_download_queue(screening, workspace / "download")

    queue = json.loads((workspace / "download" / "download_queue.json").read_text(encoding="utf-8"))
    assert queue["items"] == []


def test_queue_items_start_unapproved_and_carry_urls(workspace):
    screening = _write_screening(workspace, [_screening_row("a")])
    write_download_queue(screening, workspace / "download")

    item = json.loads((workspace / "download" / "download_queue.json").read_text(encoding="utf-8"))["items"][0]
    assert item["approved"] is False
    assert item["doi"] == "10.1000/a"
    assert item["html_url"] == "https://example.org/a"


def test_approve_marks_only_named_candidates(workspace):
    screening = _write_screening(workspace, [_screening_row("a"), _screening_row("b")])
    write_download_queue(screening, workspace / "download")
    queue_path = workspace / "download" / "download_queue.json"

    approve_download_queue(queue_path, ["a"], "tester")

    items = {i["candidate_id"]: i for i in json.loads(queue_path.read_text(encoding="utf-8"))["items"]}
    assert items["a"]["approved"] is True
    assert items["b"]["approved"] is False


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def _approved_queue(workspace, cids):
    screening = _write_screening(workspace, [_screening_row(c) for c in cids])
    write_download_queue(screening, workspace / "download")
    queue_path = workspace / "download" / "download_queue.json"
    approve_download_queue(queue_path, list(cids), "tester")
    return queue_path


def _record_download(workspace, cid, pdf: Path):
    """Simulate what the downloader records for a successful fetch."""
    path = ledger.ledger_path(workspace)
    ledger.append(path, DownloadRecord(
        candidate_id=cid, outcome=Outcome.DOWNLOADED,
        timestamp="2026-07-26T00:00:00+01:00", title=f"Paper {cid}",
        pdf_path=str(pdf.resolve()), sha256=sha256_file(pdf),
    ))
    return path


def test_manifest_rows_come_from_the_ledger(workspace):
    """No text extraction, no assignment problem — just a join on candidate_id."""
    queue_path = _approved_queue(workspace, ["a"])
    pdf = workspace / "pdfs" / "a_Paper a.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(PDF_BYTES)
    _record_download(workspace, "a", pdf)

    rows = manifest_rows(ledger.ledger_path(workspace), queue_path)

    assert len(rows) == 1
    assert rows[0]["candidate_id"] == "a"
    assert rows[0]["doi"] == "10.1000/a"       # joined from the queue
    assert rows[0]["pdf_path"] == str(pdf.resolve())


def test_manifest_rows_skip_records_whose_pdf_vanished(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    pdf = workspace / "pdfs" / "a.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(PDF_BYTES)
    _record_download(workspace, "a", pdf)
    pdf.unlink()

    assert manifest_rows(ledger.ledger_path(workspace), queue_path) == []


def test_manual_drop_is_matched_by_candidate_id_in_filename(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    drop = workspace / "manual_drop"
    drop.mkdir()
    (drop / "a_downloaded_by_hand.pdf").write_bytes(PDF_BYTES)

    rows = match_manual_drop(queue_path, workspace)

    assert [r["candidate_id"] for r in rows] == ["a"]


def test_manual_drop_matches_by_doi(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    drop = workspace / "manual_drop"
    drop.mkdir()
    (drop / "10.1000_a.pdf").write_bytes(PDF_BYTES)

    assert [r["candidate_id"] for r in match_manual_drop(queue_path, workspace)] == ["a"]


def test_manual_drop_never_claims_one_paper_twice(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    drop = workspace / "manual_drop"
    drop.mkdir()
    (drop / "a_one.pdf").write_bytes(PDF_BYTES)
    (drop / "a_two.pdf").write_bytes(PDF_BYTES)

    assert len(match_manual_drop(queue_path, workspace)) == 1


def test_manual_drop_ignores_unmatched_and_invalid_files(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    drop = workspace / "manual_drop"
    drop.mkdir()
    (drop / "totally_unrelated.pdf").write_bytes(PDF_BYTES)
    (drop / "a_stub.pdf").write_bytes(b"%PDF-1.4\nshort")

    assert match_manual_drop(queue_path, workspace) == []


def test_manual_drop_is_empty_without_the_directory(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    assert match_manual_drop(queue_path, workspace) == []


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def test_manifest_is_written_from_ledger_rows(workspace):
    queue_path = _approved_queue(workspace, ["a"])
    pdf = workspace / "pdfs" / "a_Paper a.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(PDF_BYTES)
    _record_download(workspace, "a", pdf)

    rows = manifest_rows(ledger.ledger_path(workspace), queue_path)
    count = write_download_manifest(rows, workspace / "handoff")

    manifest = json.loads((workspace / "handoff" / "download_manifest.json").read_text(encoding="utf-8"))
    assert count == 1
    assert manifest["papers"][0]["candidate_id"] == "a"


# ---------------------------------------------------------------------------
# PDF validation must mean one thing across the codebase
# ---------------------------------------------------------------------------

def test_validate_pdf_rejects_truncated_stub(tmp_path):
    """A 300-byte stub must not pass download and then fail at manifest time."""
    from academia.litreview.acquire.verify import validate_pdf as download_validate

    stub = tmp_path / "stub.pdf"
    stub.write_bytes(b"%PDF-1.4\n" + b"x" * 100)

    with pytest.raises(ValueError):
        validate_pdf(stub)
    with pytest.raises(ValueError):
        download_validate(stub)


def test_validate_pdf_accepts_a_real_pdf(tmp_path):
    from academia.litreview.acquire.verify import validate_pdf as download_validate

    good = tmp_path / "good.pdf"
    good.write_bytes(PDF_BYTES)

    validate_pdf(good)
    download_validate(good)


# ---------------------------------------------------------------------------
# Orchestrator wiring — the regression that disabled ingest
# ---------------------------------------------------------------------------

def test_run_acquire_produces_a_manifest(workspace, monkeypatch):
    """End-to-end: a successful download must yield handoff/download_manifest.json."""
    from academia.litreview import workflow_acquire

    _write_screening(workspace, [_screening_row("a")])

    def fake_acquire_pdfs(queue_path, run_dir, **kwargs):
        # A download is only "done" once it is in the ledger — that record is
        # what every later stage reads.
        pdf_dir = run_dir / "pdfs"
        pdf_dir.mkdir(parents=True, exist_ok=True)
        pdf = pdf_dir / "a_Paper a.pdf"
        pdf.write_bytes(PDF_BYTES)
        _record_download(run_dir, "a", pdf)
        return [{"candidate_id": "a", "outcome": "downloaded"}]

    monkeypatch.setattr(
        "academia.litreview.acquire.engine.acquire_pdfs", fake_acquire_pdfs
    )

    result = workflow_acquire.run_acquire(workspace, approved_by="tester")

    assert result["manifest_path"] is not None
    assert (workspace / "handoff" / "download_manifest.json").exists()
