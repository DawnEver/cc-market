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


def test_dois_are_resolved_in_one_batch(monkeypatch):
    from academia.sources import semantic_scholar as source

    seen = {}

    def post(url, payload, name, **kwargs):
        seen.update(url=url, payload=payload, name=name)
        return [
            {"externalIds": {"DOI": "10.1/A"}, "openAccessPdf": {"url": "https://r/a.pdf"}},
            None,
        ]

    monkeypatch.setattr(source, "post_json_list", post)
    assert source.resolve_open_access_pdfs(["10.1/a", "10.1/b"]) == {
        "10.1/a": "https://r/a.pdf"
    }
    assert seen["payload"] == {"ids": ["DOI:10.1/a", "DOI:10.1/b"]}


def test_openalex_resolves_all_locations_in_one_query(monkeypatch):
    from academia.sources import openalex as source

    seen = {}

    def get(url, name, **kwargs):
        seen["url"] = url
        return {
            "results": [
                {
                    "doi": "https://doi.org/10.1/A",
                    "locations": [
                        {
                            "pdf_url": "https://publisher.example/a.pdf",
                            "source": {"type": "journal"},
                        },
                        {
                            "pdf_url": "https://repository.example/a.pdf",
                            "source": {"type": "repository"},
                        },
                    ],
                }
            ]
        }

    monkeypatch.setattr(source, "get_json", get)
    assert source.resolve_open_access_pdfs(["10.1/a", "10.1/b"]) == {
        "10.1/a": "https://repository.example/a.pdf"
    }
    assert "10.1%2Fa%7C10.1%2Fb" in seen["url"]


def test_openalex_recent_works_use_resolved_author_id(monkeypatch):
    from academia.sources import openalex as source

    seen = {}

    def get(url, name, **kwargs):
        seen["url"] = url
        return {"results": []}

    monkeypatch.setattr(source, "get_json", get)
    assert source.recent_works_for_author("A123", year_from=2023, limit=7) == []
    assert "author.id%3AA123%2Cfrom_publication_date%3A2023-01-01" in seen["url"]
    assert "per-page=7" in seen["url"]


def test_openalex_batches_recent_corresponding_works(monkeypatch):
    from academia.sources import openalex as source

    seen = {}

    def get(url, name, **kwargs):
        seen["url"] = url
        return {"results": []}

    monkeypatch.setattr(source, "get_json", get)
    assert source.recent_corresponding_works(["A123", "A456"], year_from=2023) == []
    assert "corresponding_author_ids%3AA123%7CA456" in seen["url"]
    assert "from_publication_date%3A2023-01-01" in seen["url"]
