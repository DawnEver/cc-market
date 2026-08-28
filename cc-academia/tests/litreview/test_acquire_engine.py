"""Tests for the typed core: outcomes, ledger, transport ladder, engine."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from academia.litreview.acquire import ledger
from academia.litreview.acquire.engine import download_one, select_pending
from academia.litreview.acquire.transport import (
    BrowserTransport,
    HttpTransport,
    ResearchGateTransport,
    default_transports,
    needs_browser,
)
from academia.litreview.acquire.types import (
    Attempt,
    Blocked,
    Denied,
    DownloadRecord,
    NotOpenAccess,
    Outcome,
    Source,
    outcome_of,
)

PDF_BYTES = b"%PDF-1.4\n" + b"%padding\n" * 200 + b"trailer\n%%EOF\n"


# ---------------------------------------------------------------------------
# Outcome classification
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("error,expected", [
    (Blocked("captcha"), Outcome.BLOCKED),
    (Denied("1020"), Outcome.DENIED),
    (NotOpenAccess("no full text"), Outcome.NOT_OPEN_ACCESS),
    (ValueError("bad pdf"), Outcome.ERROR),
    (OSError("connection reset"), Outcome.ERROR),
])
def test_outcome_of_classifies_errors(error, expected):
    assert outcome_of(error) is expected


def test_only_downloaded_counts_as_success():
    assert Outcome.DOWNLOADED.is_success
    for other in (Outcome.BLOCKED, Outcome.DENIED, Outcome.NOT_OPEN_ACCESS,
                  Outcome.NOT_FOUND, Outcome.ERROR):
        assert not other.is_success


def test_retryable_excludes_permanent_verdicts():
    assert Outcome.BLOCKED.is_retryable
    assert Outcome.ERROR.is_retryable
    assert not Outcome.DENIED.is_retryable
    assert not Outcome.NOT_OPEN_ACCESS.is_retryable


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------

def _record(cid="p1", outcome=Outcome.DOWNLOADED, pdf_path="", sha256="", attempts=None):
    return DownloadRecord(
        candidate_id=cid, outcome=outcome, timestamp="2026-07-26T00:00:00+01:00",
        title=f"Title {cid}", pdf_path=pdf_path, sha256=sha256, attempts=attempts or [],
    )


def test_ledger_roundtrips_records(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a"))
    ledger.append(path, _record("b", Outcome.BLOCKED,
                                attempts=[Attempt("u", "http", Outcome.BLOCKED, "cf")]))

    records = ledger.read(path)

    assert [r.candidate_id for r in records] == ["a", "b"]
    assert records[1].attempts[0].transport == "http"
    assert records[1].outcome is Outcome.BLOCKED


def test_ledger_read_is_empty_when_missing(tmp_path):
    assert ledger.read(tmp_path / "nope.jsonl") == []


def test_ledger_skips_corrupt_lines(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a"))
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{not json\n\n")
    assert len(ledger.read(path)) == 1


def test_latest_record_supersedes_earlier_failure(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a", Outcome.BLOCKED))
    ledger.append(path, _record("a", Outcome.DOWNLOADED))

    assert ledger.latest_by_candidate(path)["a"].outcome is Outcome.DOWNLOADED


def test_verified_downloads_requires_the_file_to_still_exist(tmp_path):
    from academia.litreview.acquire.verify import sha256_file

    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(PDF_BYTES)
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a", pdf_path=str(pdf), sha256=sha256_file(pdf)))
    assert set(ledger.verified_downloads(path)) == {"a"}

    pdf.unlink()
    assert ledger.verified_downloads(path) == {}


def test_verified_downloads_rejects_a_changed_file(tmp_path):
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(PDF_BYTES)
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a", pdf_path=str(pdf), sha256="0" * 64))

    assert ledger.verified_downloads(path) == {}


def test_csv_mirror_is_derived_from_the_ledger(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger.append(path, _record("a"))
    ledger.append(path, _record("b", Outcome.DENIED,
                                attempts=[Attempt("u", "researchgate", Outcome.DENIED, "1020")]))

    csv_text = ledger.write_csv_mirror(path).read_text(encoding="utf-8")

    assert "a,downloaded" in csv_text
    assert "1020" in csv_text


# ---------------------------------------------------------------------------
# Transport selection
# ---------------------------------------------------------------------------

def test_transports_are_ordered_cheapest_first():
    order = [t.name for t in default_transports(page=object())]
    assert order == ["http", "browser", "researchgate"]


def test_without_a_page_only_http_is_available():
    assert [t.name for t in default_transports(page=None)] == ["http"]


def test_http_transport_declines_challenged_hosts():
    http = HttpTransport()
    assert http.can_handle(Source("https://repo.example/a.pdf"))
    assert not http.can_handle(Source("https://ieeexplore.ieee.org/document/1"))


def test_researchgate_transport_only_handles_researchgate():
    rg = ResearchGateTransport(page=object(), item={})
    assert rg.can_handle(Source("https://www.researchgate.net/search/publication?q=x"))
    assert not rg.can_handle(Source("https://arxiv.org/pdf/1"))


@pytest.mark.parametrize("url,expected", [
    ("https://ieeexplore.ieee.org/document/1", True),
    ("https://repo.uni-hannover.de/bitstream/x/content", False),
])
def test_needs_browser_routing(url, expected):
    assert needs_browser(url) is expected


# ---------------------------------------------------------------------------
# download_one — the source x transport loop
# ---------------------------------------------------------------------------

class FakeTransport:
    def __init__(self, name, cost, behaviour):
        self.name = name
        self.cost = cost
        self.behaviour = behaviour
        self.calls: list[str] = []

    def can_handle(self, source):
        return True

    def fetch(self, source, target):
        self.calls.append(source.url)
        action = self.behaviour.get(source.url, None)
        if isinstance(action, Exception):
            raise action
        if action == "ok":
            target.write_bytes(PDF_BYTES)
            return source.url
        return None


def test_download_one_returns_on_first_success(tmp_path):
    transport = FakeTransport("t", 10, {"https://a/1": "ok", "https://b/2": "ok"})
    record = download_one(
        {"candidate_id": "p1", "title": "T"},
        [Source("https://a/1"), Source("https://b/2")],
        [transport], tmp_path / "o.pdf",
    )

    assert record.outcome is Outcome.DOWNLOADED
    assert record.source_url == "https://a/1"
    assert transport.calls == ["https://a/1"]


def test_download_one_falls_through_sources(tmp_path):
    transport = FakeTransport("t", 10, {
        "https://a/1": Blocked("cf"), "https://b/2": "ok",
    })
    record = download_one(
        {"candidate_id": "p1"}, [Source("https://a/1"), Source("https://b/2")],
        [transport], tmp_path / "o.pdf",
    )

    assert record.outcome is Outcome.DOWNLOADED
    assert [a.outcome for a in record.attempts] == [Outcome.BLOCKED, Outcome.DOWNLOADED]


def test_download_one_tries_cheaper_transport_first(tmp_path):
    cheap = FakeTransport("cheap", 10, {"https://a/1": None})
    dear = FakeTransport("dear", 50, {"https://a/1": "ok"})

    record = download_one({"candidate_id": "p1"}, [Source("https://a/1")],
                          [cheap, dear], tmp_path / "o.pdf")

    assert cheap.calls and dear.calls
    assert record.outcome is Outcome.DOWNLOADED


def test_denied_disables_that_transport_for_the_rest_of_the_run(tmp_path):
    """An IP ban must not be rediscovered once per paper."""
    banned = FakeTransport("rg", 90, {
        "https://a/1": Denied("1020"), "https://a/2": Denied("1020"),
    })
    disabled: set[str] = set()

    download_one({"candidate_id": "p1"}, [Source("https://a/1")], [banned],
                 tmp_path / "o.pdf", disabled)
    assert disabled == {"rg"}

    download_one({"candidate_id": "p2"}, [Source("https://a/2")], [banned],
                 tmp_path / "o2.pdf", disabled)
    assert banned.calls == ["https://a/1"]  # second paper never called it


def test_record_reports_the_most_informative_verdict(tmp_path):
    transport = FakeTransport("t", 10, {
        "https://a/1": ValueError("boom"),
        "https://a/2": Blocked("captcha"),
    })
    record = download_one({"candidate_id": "p1"},
                          [Source("https://a/1"), Source("https://a/2")],
                          [transport], tmp_path / "o.pdf")

    assert record.outcome is Outcome.BLOCKED


def test_denied_outranks_blocked_in_the_summary(tmp_path):
    transport = FakeTransport("t", 10, {
        "https://a/1": Blocked("captcha"), "https://a/2": Denied("1020"),
    })
    record = download_one({"candidate_id": "p1"},
                          [Source("https://a/1"), Source("https://a/2")],
                          [transport], tmp_path / "o.pdf")

    assert record.outcome is Outcome.DENIED


def test_no_sources_yields_not_found_with_an_explanation(tmp_path):
    record = download_one({"candidate_id": "p1"}, [], [], tmp_path / "o.pdf")

    assert record.outcome is Outcome.NOT_FOUND
    assert "no candidate URL" in record.failure_summary()


def test_invalid_pdf_is_not_accepted_as_success(tmp_path):
    """A transport that writes HTML must not be recorded as a download."""
    class HtmlTransport(FakeTransport):
        def fetch(self, source, target):
            target.write_bytes(b"<html>login</html>")
            return source.url

    record = download_one({"candidate_id": "p1"}, [Source("https://a/1")],
                          [HtmlTransport("t", 10, {})], tmp_path / "o.pdf")

    assert record.outcome is not Outcome.DOWNLOADED
    assert not (tmp_path / "o.pdf").exists()


def test_failure_summary_lists_every_url_and_reason(tmp_path):
    transport = FakeTransport("t", 10, {
        "https://a/1": Blocked("captcha"), "https://a/2": Denied("banned"),
    })
    record = download_one({"candidate_id": "p1"},
                          [Source("https://a/1"), Source("https://a/2")],
                          [transport], tmp_path / "o.pdf")

    summary = record.failure_summary()
    assert "https://a/1" in summary and "captcha" in summary
    assert "https://a/2" in summary and "banned" in summary


# ---------------------------------------------------------------------------
# select_pending
# ---------------------------------------------------------------------------

def test_select_pending_skips_unapproved_and_completed():
    items = [
        {"candidate_id": "a", "approved": True},
        {"candidate_id": "b", "approved": False},
        {"candidate_id": "c", "approved": True},
    ]
    assert [i["candidate_id"] for i in select_pending(items, 10, {"c"})] == ["a"]


def test_select_pending_enforces_the_hard_limit():
    with pytest.raises(ValueError):
        select_pending([], limit=999)
    with pytest.raises(ValueError):
        select_pending([], limit=0)


# ---------------------------------------------------------------------------
# Browser transport ordering — the bug the old linear function had
# ---------------------------------------------------------------------------

class RecordingPage:
    """Records the order of interactions so preconditions can be asserted."""

    def __init__(self, html="<html>ok</html>"):
        self.html = html
        self.events: list[str] = []
        self.url = "https://pub.example/paper"
        self.context = type("C", (), {"request": self})()

    def locator(self, selector):
        page = self

        class Loc:
            @property
            def first(self):
                return self

            def is_visible(self):
                return "Accept" in selector or "osano" in selector

            def click(self, **kwargs):
                page.events.append("dismiss_banner")

            def get_attribute(self, name, **kwargs):
                return None

        return Loc()

    def content(self):
        return self.html

    def wait_for_timeout(self, ms):
        pass

    def get(self, url, **kwargs):
        self.events.append("request")
        return type("R", (), {"status": 404, "body": lambda self: b"", "url": url})()


def test_banner_is_dismissed_before_any_interaction():
    """The old code dismissed the banner 118 lines after the click it unblocked."""
    page = RecordingPage()
    transport = BrowserTransport(page)

    transport._prepare()

    assert page.events and page.events[0] == "dismiss_banner"


def test_browser_transport_raises_blocked_on_a_challenge_page():
    page = RecordingPage(html="<html>challenge-platform verify you are human</html>")

    with pytest.raises(Blocked):
        BrowserTransport(page)._raise_if_blocked()


def test_browser_transport_raises_blocked_on_a_paywall():
    page = RecordingPage(html="<html>Please sign in to continue</html>")

    with pytest.raises(Blocked):
        BrowserTransport(page)._raise_if_blocked()


def test_browser_transport_is_silent_on_an_ordinary_page():
    BrowserTransport(RecordingPage())._raise_if_blocked()
