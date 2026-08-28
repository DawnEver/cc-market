"""Tests for the ResearchGate search → publication → PDF flow."""

from __future__ import annotations

import pytest

from academia.litreview.acquire import researchgate as rg

PDF_BYTES = b"%PDF-1.4\n" + b"%padding\n" * 200 + b"trailer\n%%EOF\n"


@pytest.fixture(autouse=True)
def no_real_sleeping(monkeypatch):
    """Politeness pacing is real seconds — never spend them in unit tests."""
    monkeypatch.setattr(rg.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(rg, "CHALLENGE_WAIT_S", 0.0)
    rg.BREAKER.reset()  # process-wide state; never leak it between tests
    yield
    rg.BREAKER.reset()

SEARCH_HTML = """
<a href="publication/357468096_Design_and_Simulation_of_Hairpin_Winding_Motors">One</a>
<a href="/publication/392464887_Design_of_Continuous_Hairpin_Winding">Two</a>
<a href="/profile/Someone">Profile</a>
<a href="search/publication?q=next&amp;page=2">Next</a>
"""

CHALLENGE_HTML = '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>'

DENIED_HTML = (
    "<html><body>Access denied. You do not have access to www.researchgate.net."
    "<p>Error reference number: 1020</p></body></html>"
)


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------

def test_search_url_is_built_from_title():
    url = rg.search_url("A Hybrid Approach for Stator Winding Design")
    assert url.startswith("https://www.researchgate.net/search/publication?q=")
    assert "Hybrid" in url


def test_search_url_escapes_special_characters():
    assert " " not in rg.search_url("motor design & control")


def test_is_researchgate_url_detects_host():
    assert rg.is_researchgate_url("https://www.researchgate.net/search/publication?q=x")
    assert not rg.is_researchgate_url("https://arxiv.org/pdf/1")


def test_query_from_item_prefers_title_over_doi():
    assert rg.query_from_item({"title": "Deep Motors", "doi": "10.1/x"}) == "Deep Motors"


def test_query_from_item_falls_back_to_doi():
    assert rg.query_from_item({"doi": "10.1/x"}) == "10.1/x"


def test_query_from_item_recovers_query_from_existing_search_url():
    """Queues built before this feature stored a ready-made RG search URL."""
    item = {"html_url": "https://www.researchgate.net/search/publication?q=Hairpin+Winding+Design"}
    assert rg.query_from_item(item) == "Hairpin Winding Design"


def test_query_from_item_empty_when_nothing_identifies_the_paper():
    assert rg.query_from_item({}) == ""


# ---------------------------------------------------------------------------
# Parsing search results
# ---------------------------------------------------------------------------

def test_extract_publication_links_handles_relative_hrefs():
    """RG emits result links without a leading slash — the easy thing to miss."""
    links = rg.extract_publication_links(SEARCH_HTML)
    assert links == [
        "https://www.researchgate.net/publication/357468096_Design_and_Simulation_of_Hairpin_Winding_Motors",
        "https://www.researchgate.net/publication/392464887_Design_of_Continuous_Hairpin_Winding",
    ]


def test_extract_publication_links_ignores_profiles_and_pagination():
    # Match on path, not substring: the host name contains "search" itself.
    links = rg.extract_publication_links(SEARCH_HTML)
    assert links and all("/publication/" in link for link in links)
    assert not any("/profile/" in link or "/search/" in link for link in links)


def test_extract_publication_links_deduplicates():
    html = '<a href="/publication/1_A">x</a><a href="/publication/1_A">y</a>'
    assert len(rg.extract_publication_links(html)) == 1


def test_extract_publication_links_strips_tracking_query():
    """RG appends ?_sg=... to result links — matching must not stop at the quote."""
    html = '<a href="publication/12_A_Hybrid_Approach?_sg=nquiL78-u1zTsY">R</a>'
    assert rg.extract_publication_links(html) == [
        "https://www.researchgate.net/publication/12_A_Hybrid_Approach"
    ]


def test_download_url_derives_from_publication_url():
    pub = "https://www.researchgate.net/publication/357468096_Design_and_Simulation"
    assert rg.download_url(pub) == pub + "/download"


# ---------------------------------------------------------------------------
# Full-text availability
# ---------------------------------------------------------------------------

def test_has_full_text_true_when_download_offered():
    assert rg.has_full_text("<div>Download full-text PDF</div>")


def test_has_full_text_false_when_only_request_offered():
    """'Request full-text' means the author must approve — nothing to download."""
    html = "<div>Request full-text</div><div>Full-text available</div>"
    assert not rg.has_full_text(html)


def test_is_challenged_detects_cloudflare():
    assert rg.is_challenged(CHALLENGE_HTML)
    assert not rg.is_challenged("<html><body>Search Publications</body></html>")


# ---------------------------------------------------------------------------
# End-to-end flow against a fake page
# ---------------------------------------------------------------------------

class FakePage:
    """Minimal Playwright page stand-in driven by a url -> (html, pdf) map."""

    def __init__(self, pages, pdfs=None):
        self.pages = pages
        self.pdfs = pdfs or {}
        self.url = ""
        self.visited: list[str] = []
        self.context = type("C", (), {"request": self})()

    def goto(self, url, **kwargs):
        self.visited.append(url)
        self.url = url
        return type("R", (), {"status": 200, "url": url})()

    def content(self):
        return self.pages.get(self.url, "<html>missing</html>")

    def wait_for_timeout(self, ms):
        pass

    # doubles as context.request
    def get(self, url, **kwargs):
        body = self.pdfs.get(url)
        if body is None:
            return type("R", (), {"status": 404, "body": lambda self: b"", "url": url})()
        return type("R", (), {"status": 200, "body": lambda self, b=body: b, "url": url})()


SEARCH_URL = rg.search_url("Hairpin Winding")
PUB_URL = "https://www.researchgate.net/publication/1_Hairpin_Winding"


def test_fetch_downloads_first_publication_with_full_text(tmp_path):
    page = FakePage(
        {rg.HOME_URL: "<html>home</html>",
         SEARCH_URL: '<a href="/publication/1_Hairpin_Winding">R</a>',
         PUB_URL: "<div>Download full-text PDF</div>"},
        {PUB_URL + "/download": PDF_BYTES},
    )
    target = tmp_path / "o.pdf"

    assert rg.fetch(page, "Hairpin Winding", target) == PUB_URL + "/download"
    assert target.read_bytes() == PDF_BYTES


def test_fetch_warms_up_on_home_before_searching(tmp_path):
    """Hitting search cold triggers the Cloudflare challenge; home clears it."""
    page = FakePage({rg.HOME_URL: "<html>home</html>", SEARCH_URL: "<html>none</html>"})
    rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf")
    assert page.visited[0] == rg.HOME_URL


def test_fetch_skips_publications_without_full_text(tmp_path):
    page = FakePage(
        {rg.HOME_URL: "h",
         SEARCH_URL: '<a href="/publication/1_Hairpin_Winding">R</a>',
         PUB_URL: "<div>Request full-text</div>"},
        {PUB_URL + "/download": PDF_BYTES},
    )
    assert rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf") is None


def test_fetch_returns_none_when_no_results(tmp_path):
    page = FakePage({rg.HOME_URL: "h", SEARCH_URL: "<html>no results</html>"})
    assert rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf") is None


def test_fetch_returns_none_for_empty_query(tmp_path):
    page = FakePage({})
    assert rg.fetch(page, "", tmp_path / "o.pdf") is None
    assert page.visited == []


def test_fetch_rejects_non_pdf_download_body(tmp_path):
    page = FakePage(
        {rg.HOME_URL: "h",
         SEARCH_URL: '<a href="/publication/1_Hairpin_Winding">R</a>',
         PUB_URL: "<div>Download full-text PDF</div>"},
        {PUB_URL + "/download": b"<html>login wall</html>"},
    )
    assert rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf") is None
    assert not (tmp_path / "o.pdf").exists()


def test_fetch_stops_after_max_candidates(tmp_path):
    links = "".join(f'<a href="/publication/{i}_P">R</a>' for i in range(10))
    page = FakePage({rg.HOME_URL: "h", SEARCH_URL: links})
    rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf")
    visited_pubs = [u for u in page.visited if "/publication/" in u]
    assert len(visited_pubs) <= rg.MAX_CANDIDATES


def test_fetch_raises_when_challenge_blocks_search(tmp_path, monkeypatch):
    """A challenge is reported, not silently treated as 'paper not on RG'."""
    monkeypatch.setattr(rg, "CHALLENGE_WAIT_S", 0.0)
    page = FakePage({rg.HOME_URL: "h", SEARCH_URL: CHALLENGE_HTML})
    with pytest.raises(rg.ChallengeError):
        rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf")


# ---------------------------------------------------------------------------
# Bot-check handling
# ---------------------------------------------------------------------------

class _ClearingPage:
    """Serves the challenge N times, then the real page — like a human solving it."""

    def __init__(self, challenge_reads):
        self.remaining = challenge_reads

    def content(self):
        if self.remaining > 0:
            self.remaining -= 1
            return CHALLENGE_HTML
        return "<html>Search Publications</html>"


def test_wait_for_clearance_returns_once_check_clears(monkeypatch):
    monkeypatch.setattr(rg.time, "sleep", lambda s: None)
    page = _ClearingPage(challenge_reads=2)

    result = rg.wait_for_clearance(page, CHALLENGE_HTML, wait_s=60)

    assert not rg.is_challenged(result)


def test_wait_for_clearance_gives_up_after_timeout():
    page = type("P", (), {"content": lambda self: CHALLENGE_HTML})()

    assert rg.is_challenged(rg.wait_for_clearance(page, CHALLENGE_HTML, wait_s=0.01))


def test_wait_for_clearance_is_a_noop_when_not_challenged():
    html = "<html>fine</html>"
    assert rg.wait_for_clearance(None, html) is html


def test_wait_for_clearance_returns_early_on_ip_ban():
    """A ban is not a check — don't sit through the whole timeout."""
    page = type("P", (), {"content": lambda self: DENIED_HTML})()
    assert rg.is_access_denied(rg.wait_for_clearance(page, CHALLENGE_HTML, wait_s=60))


# ---------------------------------------------------------------------------
# Cloudflare error 1020 — IP ban, not a solvable check
# ---------------------------------------------------------------------------

def test_is_access_denied_detects_error_1020():
    assert rg.is_access_denied(DENIED_HTML)
    assert not rg.is_access_denied(CHALLENGE_HTML)
    assert not rg.is_access_denied("<html>Search Publications</html>")


def test_fetch_raises_access_denied_and_trips_breaker(tmp_path):
    page = FakePage({rg.HOME_URL: DENIED_HTML})

    with pytest.raises(rg.AccessDeniedError):
        rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf")
    assert rg.BREAKER.tripped


def test_fetch_short_circuits_once_breaker_tripped(tmp_path):
    """After a ban, later papers must not spend another request confirming it."""
    rg.BREAKER.trip()
    page = FakePage({rg.HOME_URL: "<html>home</html>"})

    with pytest.raises(rg.AccessDeniedError):
        rg.fetch(page, "Another Paper", tmp_path / "o.pdf")
    assert page.visited == []


def test_ban_on_publication_page_also_trips_breaker(tmp_path):
    page = FakePage(
        {rg.HOME_URL: "h",
         SEARCH_URL: '<a href="/publication/1_Hairpin_Winding">R</a>',
         PUB_URL: DENIED_HTML},
    )
    with pytest.raises(rg.AccessDeniedError):
        rg.fetch(page, "Hairpin Winding", tmp_path / "o.pdf")
    assert rg.BREAKER.tripped
