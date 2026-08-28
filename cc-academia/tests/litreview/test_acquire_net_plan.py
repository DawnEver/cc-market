"""Tests for the shared HTTP policy and the dry-run source plan."""

from __future__ import annotations

import json

import pytest

from academia.litreview.acquire import net
from academia.litreview.acquire.engine import plan_sources


class FakeResponse:
    def __init__(self, status=200):
        self.status_code = status
        self.headers: dict[str, str] = {}
        self.content = b""
        self.url = "https://x/"


# ---------------------------------------------------------------------------
# HTTP policy
# ---------------------------------------------------------------------------

def test_headers_identify_the_client_and_omit_empty_referer():
    headers = net.default_headers()
    assert "User-Agent" in headers and "X-Contact" in headers
    assert "Referer" not in headers


def test_referer_is_set_when_given():
    assert net.default_headers(referer="https://a/b")["Referer"] == "https://a/b"


def test_get_retries_transient_statuses_then_returns(monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    seen: list[int] = []

    def fake_get(url, **kwargs):
        seen.append(1)
        return FakeResponse(503 if len(seen) < 3 else 200)

    monkeypatch.setattr(net.requests, "get", fake_get)

    assert net.get("https://x/").status_code == 200
    assert len(seen) == 3


@pytest.mark.parametrize("status", [403, 404, 401])
def test_get_does_not_retry_a_definitive_answer(status, monkeypatch):
    """Retrying a 403 wastes time and can escalate throttling into a ban."""
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    calls: list[int] = []

    def fake_get(url, **kwargs):
        calls.append(1)
        return FakeResponse(status)

    monkeypatch.setattr(net.requests, "get", fake_get)

    assert net.get("https://x/").status_code == status
    assert len(calls) == 1


def test_get_retries_connection_errors_and_reraises(monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    calls: list[int] = []

    def boom(url, **kwargs):
        calls.append(1)
        raise OSError("connection reset")

    monkeypatch.setattr(net.requests, "get", boom)

    with pytest.raises(OSError):
        net.get("https://x/")
    assert len(calls) == net.MAX_RETRIES


def test_get_gives_up_after_max_retries_on_429(monkeypatch):
    monkeypatch.setattr(net.time, "sleep", lambda s: None)
    calls: list[int] = []

    def throttled(url, **kwargs):
        calls.append(1)
        return FakeResponse(429)

    monkeypatch.setattr(net.requests, "get", throttled)

    assert net.get("https://x/").status_code == 429
    assert len(calls) == net.MAX_RETRIES


# ---------------------------------------------------------------------------
# Dry-run plan
# ---------------------------------------------------------------------------

def _queue(tmp_path, items):
    path = tmp_path / "queue.json"
    path.write_text(json.dumps({"items": items}), encoding="utf-8")
    return path


def test_plan_lists_sources_in_priority_order(tmp_path):
    item = {
        "candidate_id": "a", "title": "Hairpin Windings",
        "pdf_url": "https://ieeexplore.ieee.org/document/1",
        "html_url": "https://repo.uni-hannover.de/bitstream/x/content",
    }
    plans = plan_sources(_queue(tmp_path, [item]), tmp_path, resolve_oa=False)

    urls = [s["url"] for s in plans[0]["sources"]]
    assert urls[0].startswith("https://repo.uni-hannover.de")


def test_plan_labels_the_transport_each_source_needs(tmp_path):
    item = {"candidate_id": "a", "pdf_url": "https://ieeexplore.ieee.org/document/1"}
    sources = plan_sources(_queue(tmp_path, [item]), tmp_path, resolve_oa=False)[0]["sources"]

    by_url = {s["url"]: s["transport"] for s in sources}
    assert by_url["https://ieeexplore.ieee.org/document/1"] == "browser"


def test_plan_includes_unapproved_items(tmp_path):
    """The queue is still unapproved when a plan is previewed."""
    item = {"candidate_id": "a", "title": "T", "approved": False,
            "pdf_url": "https://repo.example/a.pdf"}
    assert len(plan_sources(_queue(tmp_path, [item]), tmp_path, resolve_oa=False)) == 1


def test_plan_downloads_nothing(tmp_path):
    item = {"candidate_id": "a", "pdf_url": "https://repo.example/a.pdf"}
    plan_sources(_queue(tmp_path, [item]), tmp_path, resolve_oa=False)

    assert not (tmp_path / "pdfs").exists()


def test_plan_respects_the_limit(tmp_path):
    items = [{"candidate_id": str(i), "pdf_url": f"https://x/{i}.pdf"} for i in range(5)]
    assert len(plan_sources(_queue(tmp_path, items), tmp_path, limit=2, resolve_oa=False)) == 2


def test_plan_skips_papers_already_in_the_ledger(tmp_path):
    from academia.litreview.acquire import ledger
    from academia.litreview.acquire.types import DownloadRecord, Outcome
    from academia.litreview.acquire.verify import sha256_file

    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF-1.4\n" + b"%pad\n" * 300 + b"%%EOF\n")
    ledger.append(ledger.ledger_path(tmp_path), DownloadRecord(
        candidate_id="a", outcome=Outcome.DOWNLOADED, timestamp="t",
        pdf_path=str(pdf), sha256=sha256_file(pdf),
    ))

    items = [{"candidate_id": "a", "pdf_url": "https://x/a.pdf"},
             {"candidate_id": "b", "pdf_url": "https://x/b.pdf"}]
    plans = plan_sources(_queue(tmp_path, items), tmp_path, resolve_oa=False)

    assert [p["candidate_id"] for p in plans] == ["b"]
