"""Tests for the browser-free HTTP PDF fetch layer."""

from __future__ import annotations

import pytest

from academia.litreview.acquire import http_fetch

PDF_BYTES = b"%PDF-1.4\n" + b"%padding\n" * 200 + b"trailer\n%%EOF\n"


class FakeResponse:
    def __init__(self, content=b"", status=200, content_type="text/html", url="https://x/"):
        self.content = content
        self.status_code = status
        self.headers = {"content-type": content_type}
        self.url = url

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# PDF link extraction from a landing page
# ---------------------------------------------------------------------------

def test_extract_prefers_citation_pdf_url_meta():
    """Highwire metadata is the publisher's own declaration — trust it first."""
    html = """
    <meta name="citation_pdf_url" content="https://repo.example/files/1/paper.pdf">
    <a href="/other/thing.pdf">Other</a>
    """
    links = http_fetch.extract_pdf_links(html, "https://repo.example/en/publications/x")
    assert links[0] == "https://repo.example/files/1/paper.pdf"


def test_extract_finds_pure_repository_file_link():
    html = '<a href="/files/407380590/PEMD_2024_HMW_FINAL.pdf">Accepted manuscript</a>'
    links = http_fetch.extract_pdf_links(html, "https://research-information.bris.ac.uk/en/publications/abc")
    assert "https://research-information.bris.ac.uk/files/407380590/PEMD_2024_HMW_FINAL.pdf" in links


def test_extract_resolves_relative_links_against_base():
    html = '<a href="paper.pdf">PDF</a>'
    links = http_fetch.extract_pdf_links(html, "https://repo.example/a/b/index.html")
    assert links == ["https://repo.example/a/b/paper.pdf"]


def test_extract_finds_dspace_bitstream_without_pdf_suffix():
    html = '<a href="/server/api/core/bitstreams/abc-123/content">Download</a>'
    links = http_fetch.extract_pdf_links(html, "https://repo.uni-hannover.de/x")
    assert links == ["https://repo.uni-hannover.de/server/api/core/bitstreams/abc-123/content"]


def test_extract_ignores_unrelated_links():
    html = '<a href="/about">About</a><a href="/help.html">Help</a>'
    assert http_fetch.extract_pdf_links(html, "https://repo.example/x") == []


def test_extract_deduplicates():
    html = '<a href="/a.pdf">1</a><a href="/a.pdf">2</a>'
    assert http_fetch.extract_pdf_links(html, "https://repo.example/x") == ["https://repo.example/a.pdf"]


# ---------------------------------------------------------------------------
# fetch_pdf
# ---------------------------------------------------------------------------

def test_fetch_pdf_saves_direct_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(http_fetch, "_get", lambda url, **kw: FakeResponse(
        PDF_BYTES, content_type="application/pdf", url=url))

    target = tmp_path / "out.pdf"
    assert http_fetch.fetch_pdf("https://repo.example/a.pdf", target) == "https://repo.example/a.pdf"
    assert target.read_bytes() == PDF_BYTES


def test_fetch_pdf_follows_landing_page_to_pdf(tmp_path, monkeypatch):
    """The real win: a repository landing page resolves without a browser."""
    landing = b'<meta name="citation_pdf_url" content="https://repo.example/files/1/p.pdf">'

    def fake_get(url, **kw):
        if url.endswith(".pdf"):
            return FakeResponse(PDF_BYTES, content_type="application/pdf", url=url)
        return FakeResponse(landing, url=url)

    monkeypatch.setattr(http_fetch, "_get", fake_get)

    target = tmp_path / "out.pdf"
    assert http_fetch.fetch_pdf("https://repo.example/en/publications/x", target) == \
        "https://repo.example/files/1/p.pdf"
    assert target.read_bytes() == PDF_BYTES


def test_fetch_pdf_returns_none_when_no_pdf_found(tmp_path, monkeypatch):
    monkeypatch.setattr(http_fetch, "_get", lambda url, **kw: FakeResponse(b"<html>nothing</html>", url=url))
    assert http_fetch.fetch_pdf("https://repo.example/x", tmp_path / "o.pdf") is None
    assert not (tmp_path / "o.pdf").exists()


def test_fetch_pdf_trusts_magic_bytes_over_content_type(tmp_path, monkeypatch):
    """Some repositories serve PDFs as application/octet-stream."""
    monkeypatch.setattr(http_fetch, "_get", lambda url, **kw: FakeResponse(
        PDF_BYTES, content_type="application/octet-stream", url=url))
    assert http_fetch.fetch_pdf("https://repo.example/dl", tmp_path / "o.pdf") is not None


def test_fetch_pdf_rejects_html_masquerading_as_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(http_fetch, "_get", lambda url, **kw: FakeResponse(
        b"<!DOCTYPE html><html>login</html>", content_type="application/pdf", url=url))
    assert http_fetch.fetch_pdf("https://x/a.pdf", tmp_path / "o.pdf") is None


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
def test_fetch_pdf_returns_none_on_error_status(tmp_path, monkeypatch, status):
    """A block here is not fatal — the browser layer still gets its turn."""
    monkeypatch.setattr(http_fetch, "_get", lambda url, **kw: FakeResponse(
        b"denied", status=status, url=url))
    assert http_fetch.fetch_pdf("https://x/a.pdf", tmp_path / "o.pdf") is None


def test_fetch_pdf_survives_network_error(tmp_path, monkeypatch):
    def boom(url, **kw):
        raise OSError("connection reset")

    monkeypatch.setattr(http_fetch, "_get", boom)
    assert http_fetch.fetch_pdf("https://x/a.pdf", tmp_path / "o.pdf") is None


def test_fetch_pdf_does_not_recurse_past_landing_page(tmp_path, monkeypatch):
    """Landing page → landing page must terminate, not loop."""
    calls: list[str] = []

    def fake_get(url, **kw):
        calls.append(url)
        return FakeResponse(b'<a href="/next.pdf">PDF</a>', url=url)

    monkeypatch.setattr(http_fetch, "_get", fake_get)
    assert http_fetch.fetch_pdf("https://x/start", tmp_path / "o.pdf") is None
    assert len(calls) <= 1 + http_fetch.MAX_LINKS_PER_PAGE
