"""Download-workflow tests: OA resolution, source ranking, multi-URL fallback."""

from __future__ import annotations

import json

import pytest

from academia.litreview.acquire import ledger, oa_resolve
from academia.litreview.acquire.download import AccessBlockedError, candidate_urls
from academia.litreview.acquire.engine import acquire_pdfs
from academia.litreview.acquire.transport import BrowserTransport, needs_browser
from academia.litreview.acquire.types import Outcome, Source


def _fetch_linked_pdf(page, target, base_url):
    """Adapter: the linked-PDF strategy now lives on the browser transport."""
    return BrowserTransport(page)._from_linked_pdf(target, base_url, None, [])


def _needs_browser(url):
    return needs_browser(url)

PDF_BYTES = b"%PDF-1.4\n" + b"%padding\n" * 200 + b"trailer\n%%EOF\n"


# ---------------------------------------------------------------------------
# Source ranking — AGENTS.md priority: repo > preprint > aggregator > publisher
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url,expected", [
    ("https://repo.uni-hannover.de/bitstream/x/content", oa_resolve.RANK_REPOSITORY),
    ("https://acris.aalto.fi/ws/portalfiles/portal/1/a.pdf", oa_resolve.RANK_REPOSITORY),
    ("https://arxiv.org/pdf/2401.00001", oa_resolve.RANK_PREPRINT),
    ("https://www.techrxiv.org/doi/pdf/10.1/x", oa_resolve.RANK_PREPRINT),
    ("https://www.researchgate.net/publication/123_X", oa_resolve.RANK_AGGREGATOR),
    ("https://link.springer.com/article/10.1007/x", oa_resolve.RANK_PUBLISHER),
    ("https://ieeexplore.ieee.org/document/123", oa_resolve.RANK_PUBLISHER),
])
def test_rank_url_follows_agent_priority(url, expected):
    assert oa_resolve.rank_url(url) == expected


def test_repository_outranks_publisher_when_sorted():
    urls = [
        "https://ieeexplore.ieee.org/document/123",
        "https://link.springer.com/article/10.1007/x",
        "https://repo.uni-hannover.de/bitstream/x/content",
        "https://arxiv.org/pdf/2401.00001",
    ]
    ranked = oa_resolve.rank_urls(urls)
    assert ranked[0].startswith("https://repo.uni-hannover.de")
    assert ranked[1].startswith("https://arxiv.org")


def test_rank_urls_dedupes_preserving_best_position():
    urls = ["https://arxiv.org/pdf/1", "https://arxiv.org/pdf/1"]
    assert oa_resolve.rank_urls(urls) == ["https://arxiv.org/pdf/1"]


def test_search_pages_are_ranked_last():
    """A ResearchGate *search* URL is not a paper URL — it must not win."""
    urls = [
        "https://www.researchgate.net/search/publication?q=foo",
        "https://ieeexplore.ieee.org/document/123",
    ]
    assert oa_resolve.rank_urls(urls)[0].startswith("https://ieeexplore")


# ---------------------------------------------------------------------------
# OA resolution by DOI
# ---------------------------------------------------------------------------

def test_resolve_oa_urls_merges_providers(monkeypatch):
    monkeypatch.setattr(oa_resolve, "_unpaywall_urls", lambda doi, **kw: ["https://repo.example.edu/bitstream/a/content"])
    monkeypatch.setattr(oa_resolve, "_openalex_urls", lambda doi, **kw: ["https://arxiv.org/pdf/2401.1"])
    monkeypatch.setattr(oa_resolve, "_semantic_scholar_urls", lambda doi, **kw: ["https://ieeexplore.ieee.org/document/1"])

    urls = oa_resolve.resolve_oa_urls("10.1/x")

    assert urls[0].startswith("https://repo.example.edu")
    assert "https://arxiv.org/pdf/2401.1" in urls
    assert len(urls) == 3


def test_resolve_oa_urls_survives_provider_failure(monkeypatch):
    def boom(doi, **kw):
        raise RuntimeError("network down")

    monkeypatch.setattr(oa_resolve, "_unpaywall_urls", boom)
    monkeypatch.setattr(oa_resolve, "_openalex_urls", lambda doi, **kw: ["https://arxiv.org/pdf/2401.1"])
    monkeypatch.setattr(oa_resolve, "_semantic_scholar_urls", boom)

    assert oa_resolve.resolve_oa_urls("10.1/x") == ["https://arxiv.org/pdf/2401.1"]


def test_resolve_oa_urls_without_doi_is_empty():
    assert oa_resolve.resolve_oa_urls("") == []


# ---------------------------------------------------------------------------
# candidate_urls — the per-item download plan
# ---------------------------------------------------------------------------

def test_candidate_urls_prefers_resolved_repository_over_queue_url(monkeypatch):
    monkeypatch.setattr(
        oa_resolve, "resolve_oa_urls",
        lambda doi, title=None: ["https://repo.example.edu/bitstream/a/content"],
    )
    item = {
        "doi": "10.1/x",
        "html_url": "https://www.researchgate.net/search/publication?q=foo",
        "pdf_url": "",
    }
    urls = candidate_urls(item)
    assert urls[0] == "https://repo.example.edu/bitstream/a/content"
    assert "https://www.researchgate.net/search/publication?q=foo" in urls


def test_candidate_urls_without_doi_uses_queue_urls_only():
    item = {"pdf_url": "https://x.org/a.pdf", "html_url": "https://x.org/a"}
    assert candidate_urls(item, resolve=False) == ["https://x.org/a.pdf", "https://x.org/a"]


def test_candidate_urls_falls_back_to_doi_org_link():
    item = {"doi": "10.1/x", "pdf_url": "", "html_url": ""}
    assert "https://doi.org/10.1/x" in candidate_urls(item, resolve=False)


def test_doi_org_redirect_is_tried_after_concrete_urls():
    """doi.org only redirects to the paywall — a real URL is always better."""
    item = {"doi": "10.1/x", "html_url": "https://unknown-host.example/paper/1"}
    urls = candidate_urls(item, resolve=False)
    assert urls[:2] == ["https://unknown-host.example/paper/1", "https://doi.org/10.1/x"]


def test_candidate_urls_normalizes_prefixed_doi():
    item = {"doi": "https://doi.org/10.1/x"}
    assert candidate_urls(item, resolve=False)[0] == "https://doi.org/10.1/x"


def test_candidate_urls_empty_item_is_empty():
    assert candidate_urls({}, resolve=False) == []


def test_candidate_urls_always_appends_researchgate_search_last():
    """Every paper gets an RG attempt, but only after cheaper sources."""
    item = {"title": "Hairpin Winding Design", "pdf_url": "https://repo.example/bitstream/a/content"}
    urls = candidate_urls(item, resolve=False)
    assert urls[0] == "https://repo.example/bitstream/a/content"
    assert "researchgate.net/search/publication" in urls[-1]
    assert "Hairpin" in urls[-1]


def test_candidate_urls_adds_only_one_researchgate_search():
    """RG rate limits escalate to an IP ban — never spend two hits on one paper."""
    item = {
        "title": "Hairpin Winding Design",
        "html_url": "https://www.researchgate.net/search/publication?q=Hairpin+Winding+Design+2024",
    }
    urls = candidate_urls(item, resolve=False)
    assert sum("researchgate.net" in u for u in urls) == 1


def test_candidate_urls_adds_no_researchgate_url_without_identifiers():
    assert not any("researchgate" in u for u in candidate_urls({"pdf_url": "https://x/a.pdf"},
                                                               resolve=False))


# ---------------------------------------------------------------------------
# acquire_pdfs — multi-URL fallback and error reporting
# ---------------------------------------------------------------------------

def _queue(tmp_path, item):
    path = tmp_path / "queue.json"
    path.write_text(json.dumps({"items": [item]}), encoding="utf-8")
    return path


def test_acquire_falls_back_to_next_url_after_block(tmp_path):
    """The blocked publisher page must not end the item — the mirror is tried."""
    item = {
        "candidate_id": "p1", "title": "Paper One", "approved": True,
        "pdf_url": "https://ieeexplore.ieee.org/document/1",
        "html_url": "https://link.springer.com/article/10.1007/x",
    }
    tried: list[str] = []

    def downloader(it, target, url):
        tried.append(url)
        if "ieee" in url:
            raise AccessBlockedError("cloudflare")
        target.write_bytes(PDF_BYTES)
        return url

    rows = acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)

    assert len(tried) == 2
    assert rows[0]["outcome"] == Outcome.DOWNLOADED.value
    assert rows[0]["source_url"] == "https://link.springer.com/article/10.1007/x"


def test_acquire_records_real_error_detail_when_all_urls_fail(tmp_path):
    item = {
        "candidate_id": "p1", "title": "Paper One", "approved": True,
        "pdf_url": "https://publisher.example/doc", "html_url": "https://other.example/doc",
    }

    def downloader(it, target, url):
        raise AccessBlockedError(f"turnstile on {url}")

    acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)

    log = (tmp_path / "download" / "download_log.csv").read_text(encoding="utf-8")
    assert "turnstile on https://publisher.example/doc" in log
    assert "turnstile on https://other.example/doc" in log


def test_acquire_reports_no_source_when_item_has_no_urls(tmp_path):
    # No title/DOI/URL at all, so not even a ResearchGate search can be built.
    item = {"candidate_id": "p1", "approved": True}

    def downloader(it, target, url):  # pragma: no cover - must not be called
        raise AssertionError("downloader should not run")

    rows = acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)

    assert rows == []
    log = (tmp_path / "download" / "download_log.csv").read_text(encoding="utf-8")
    assert "no candidate URL" in log


def test_acquire_stops_trying_urls_once_one_succeeds(tmp_path):
    item = {
        "candidate_id": "p1", "title": "P", "approved": True,
        "pdf_url": "https://repo.example/a.pdf", "html_url": "https://publisher.example/doc",
    }
    tried: list[str] = []

    def downloader(it, target, url):
        tried.append(url)
        target.write_bytes(PDF_BYTES)
        return url

    acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)
    assert tried == ["https://repo.example/a.pdf"]


# ---------------------------------------------------------------------------
# Browser layer: link extraction and host routing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url,expected", [
    ("https://ieeexplore.ieee.org/document/1", True),
    ("https://www.researchgate.net/publication/1", True),
    ("https://repo.uni-hannover.de/bitstream/x/content", False),
    ("https://arxiv.org/pdf/2401.1", False),
])
def test_needs_browser_routes_only_challenged_hosts(url, expected):
    assert _needs_browser(url) is expected


class _FakeRequest:
    def __init__(self, bodies, page):
        self.bodies = bodies
        self.page = page
        self.seen: list[str] = []

    def get(self, url, **kwargs):
        self.seen.append(url)
        # Model Cloudflare: the body is only served once the page has visited it.
        if url in self.page.needs_clearance and url not in self.page.visited:
            return type("R", (), {"status": 403, "body": lambda self: b"<html>", "url": url})()
        body = self.bodies.get(url)
        if body is None:
            raise RuntimeError("404")
        return type("R", (), {"status": 200, "body": lambda self, b=body: b, "url": url})()


class _FakePage:
    def __init__(self, html, bodies, url="https://repo.example/pub/1", needs_clearance=()):
        self._html = html
        self.url = url
        self.needs_clearance = set(needs_clearance)
        self.visited: set[str] = set()
        self.context = type("C", (), {"request": _FakeRequest(bodies, self)})()

    def content(self):
        return self._html

    def goto(self, url, **kwargs):
        self.visited.add(url)

    def wait_for_timeout(self, ms):
        pass


def test_fetch_linked_pdf_recovers_pdf_the_selectors_miss(tmp_path):
    """The Bristol case: PDF is linked in HTML but no visible download button."""
    pdf_url = "https://repo.example/files/1/paper.pdf"
    page = _FakePage(f'<a href="/files/1/paper.pdf">Accepted manuscript</a>', {pdf_url: PDF_BYTES})
    target = tmp_path / "o.pdf"

    assert _fetch_linked_pdf(page, target, page.url) == pdf_url
    assert target.read_bytes() == PDF_BYTES


def test_fetch_linked_pdf_skips_links_that_are_not_pdfs(tmp_path):
    page = _FakePage(
        '<a href="/files/1/cover.pdf">Cover</a><a href="/files/2/paper.pdf">Paper</a>',
        {"https://repo.example/files/1/cover.pdf": b"<html>no</html>",
         "https://repo.example/files/2/paper.pdf": PDF_BYTES},
    )
    target = tmp_path / "o.pdf"
    assert _fetch_linked_pdf(page, target, page.url) == "https://repo.example/files/2/paper.pdf"


def test_fetch_linked_pdf_navigates_to_clear_cloudflare_then_retries(tmp_path):
    """A 403 on the file endpoint is cleared by visiting it in the browser."""
    pdf_url = "https://repo.example/files/1/paper.pdf"
    page = _FakePage(
        '<a href="/files/1/paper.pdf">PDF</a>', {pdf_url: PDF_BYTES},
        needs_clearance=[pdf_url],
    )
    target = tmp_path / "o.pdf"

    assert _fetch_linked_pdf(page, target, page.url) == pdf_url
    assert pdf_url in page.visited
    assert target.read_bytes() == PDF_BYTES


def test_fetch_linked_pdf_returns_none_when_page_has_no_links(tmp_path):
    page = _FakePage("<html>nothing here</html>", {})
    assert _fetch_linked_pdf(page, tmp_path / "o.pdf", page.url) is None


def test_acquire_records_researchgate_ban_without_crashing(tmp_path):
    """An RG IP ban must be logged like any other dead source, not kill the run."""
    from academia.litreview.acquire import researchgate

    item = {
        "candidate_id": "p1", "title": "P", "approved": True,
        "pdf_url": "https://www.researchgate.net/search/publication?q=P",
    }

    def downloader(it, target, url):
        raise researchgate.AccessDeniedError("Cloudflare error 1020")

    rows = acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)

    assert rows == []
    log = (tmp_path / "download" / "download_log.csv").read_text(encoding="utf-8")
    assert "1020" in log


def test_acquire_rejects_non_pdf_and_tries_next_url(tmp_path):
    """A downloader that writes HTML must not be accepted as success."""
    item = {
        "candidate_id": "p1", "title": "P", "approved": True,
        "pdf_url": "https://a.example/x", "html_url": "https://b.example/x",
    }

    def downloader(it, target, url):
        if "a.example" in url:
            target.write_bytes(b"<html>nope</html>")
        else:
            target.write_bytes(PDF_BYTES)
        return url

    rows = acquire_pdfs(_queue(tmp_path, item), tmp_path, downloader=downloader)
    assert rows[0]["source_url"] == "https://b.example/x"
