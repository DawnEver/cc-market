"""Providers must not discard OA PDF links they were already given."""

from __future__ import annotations

from academia.sources.semantic_scholar import (
    SEARCH_FIELDS,
    open_access_pdf,
)


def test_search_fields_requestopen_access_pdf():
    """Without this field the API never returns the link at all."""
    assert "openAccessPdf" in SEARCH_FIELDS


def test_open_access_pdf_is_used_when_present():
    record = {"openAccessPdf": {"url": "https://repo.example/paper.pdf", "status": "GREEN"}}
    assert open_access_pdf(record) == "https://repo.example/paper.pdf"


def test_falls_back_to_arxiv_pdf():
    record = {"openAccessPdf": None, "externalIds": {"ArXiv": "2401.00001"}}
    assert open_access_pdf(record) == "https://arxiv.org/pdf/2401.00001"


def test_prefers_open_access_pdf_over_arxiv():
    record = {
        "openAccessPdf": {"url": "https://repo.example/paper.pdf"},
        "externalIds": {"ArXiv": "2401.00001"},
    }
    assert open_access_pdf(record) == "https://repo.example/paper.pdf"


def test_empty_when_no_open_access_copy():
    assert open_access_pdf({"externalIds": {"DOI": "10.1/x"}}) == ""
    assert open_access_pdf({}) == ""


def test_tolerates_malformed_payloads():
    assert open_access_pdf({"openAccessPdf": "not-a-dict"}) == ""
    assert open_access_pdf({"externalIds": "not-a-dict"}) == ""
