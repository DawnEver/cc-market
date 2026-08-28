"""Tests for literature_review/export/zotero_maintenance.py."""

from __future__ import annotations

import pytest

from academia.litreview.zotero import zotero_maintenance as zm

# ── identifier extraction ───────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("RepresentativeFamilies_JACM2016_preprint_1304.4626.pdf", "1304.4626"),
        ("arXiv: 2002.04368", "2002.04368"),
        ("see https://arxiv.org/abs/1103.0534v2", "1103.0534"),
        ("no identifier here", None),
        ("10.1145/3708319 is a doi not arxiv", None),
    ],
)
def test_extract_arxiv_id(text, expected):
    assert zm.extract_arxiv_id(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("doi: 10.1145/3708319.", "10.1145/3708319"),
        ("https://doi.org/10.1016/j.jcss.2020.01.001", "10.1016/j.jcss.2020.01.001"),
        ("(10.1007/s00453-019-00594-4)", "10.1007/s00453-019-00594-4"),
        ("plain text", None),
    ],
)
def test_extract_doi(text, expected):
    assert zm.extract_doi(text) == expected


# ── needs_enrichment ────────────────────────────────────────────────


def test_needs_enrichment_flags_bare_document():
    assert zm.needs_enrichment({"itemType": "document", "title": "x.pdf"})


def test_needs_enrichment_flags_filename_title():
    assert zm.needs_enrichment({"itemType": "journalArticle", "title": "Paper_FOCS2011.pdf"})


def test_needs_enrichment_skips_rich_items():
    rich = {
        "itemType": "journalArticle",
        "title": "A real title",
        "creators": [{"creatorType": "author", "lastName": "Fomin"}],
    }
    assert not zm.needs_enrichment(rich)


def test_needs_enrichment_skips_attachments():
    assert not zm.needs_enrichment({"itemType": "attachment", "title": "x.pdf"})


# ── arXiv parsing ───────────────────────────────────────────────────

ARXIV_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1304.4626v3</id>
    <published>2013-04-16T21:16:34Z</published>
    <title>Efficient Computation of Representative Sets with
Applications in Parameterized and Exact Algorithms</title>
    <summary>  Let M be a matroid...  </summary>
    <author><name>Fedor V. Fomin</name></author>
    <author><name>Daniel Lokshtanov</name></author>
  </entry>
</feed>"""


def test_parse_arxiv_atom():
    meta = zm.parse_arxiv_atom(ARXIV_XML)
    assert meta["arxiv_id"] == "1304.4626"
    assert "Efficient Computation" in meta["title"]
    assert "\n" not in meta["title"]
    assert meta["date"] == "2013-04-16"
    assert meta["authors"] == ["Fedor V. Fomin", "Daniel Lokshtanov"]


def test_parse_arxiv_atom_empty():
    assert zm.parse_arxiv_atom("<feed xmlns='http://www.w3.org/2005/Atom'/>") is None
    assert zm.parse_arxiv_atom("not xml") is None


def test_arxiv_to_update_maps_to_preprint():
    meta = zm.parse_arxiv_atom(ARXIV_XML)
    upd = zm.arxiv_to_update(meta)
    assert upd["itemType"] == "preprint"
    assert upd["creators"][0] == {
        "creatorType": "author", "firstName": "Fedor V.", "lastName": "Fomin"
    }
    assert upd["extra"] == "arXiv: 1304.4626"
    assert upd["url"] == "https://arxiv.org/abs/1304.4626"


def test_split_name_keeps_surname_particles():
    assert zm._split_name("Mark de Berg")["lastName"] == "de Berg"
    assert zm._split_name("Mark de Berg")["firstName"] == "Mark"
    assert zm._split_name("Johan van Rooij")["lastName"] == "van Rooij"
    assert zm._split_name("Fedor V. Fomin") == {
        "creatorType": "author", "firstName": "Fedor V.", "lastName": "Fomin"
    }


# ── CrossRef mapping ────────────────────────────────────────────────

CROSSREF_WORK = {
    "type": "journal-article",
    "title": ["Cut & Count"],
    "author": [
        {"given": "Marek", "family": "Cygan"},
        {"given": "Jesper", "family": "Nederlof"},
    ],
    "DOI": "10.1109/FOCS.2011.27",
    "URL": "https://doi.org/10.1109/FOCS.2011.27",
    "container-title": ["IEEE FOCS"],
    "issued": {"date-parts": [[2011, 10]]},
    "abstract": "<jats:p>We show...</jats:p>",
}


def test_crossref_to_update():
    upd = zm.crossref_to_update(CROSSREF_WORK)
    assert upd["itemType"] == "journalArticle"
    assert upd["title"] == "Cut & Count"
    assert upd["creators"][1]["lastName"] == "Nederlof"
    assert upd["DOI"] == "10.1109/FOCS.2011.27"
    assert upd["date"] == "2011-10"
    assert upd["publicationTitle"] == "IEEE FOCS"
    assert "<jats:p>" not in upd["abstractNote"]


def test_crossref_container_field_is_type_specific():
    """conferencePaper needs proceedingsTitle — publicationTitle is rejected by the API."""
    work = dict(CROSSREF_WORK, type="proceedings-article")
    upd = zm.crossref_to_update(work)
    assert upd["itemType"] == "conferencePaper"
    assert "publicationTitle" not in upd
    assert upd["proceedingsTitle"] == "IEEE FOCS"


# ── plan_update with injected fetcher ───────────────────────────────


def _item(title, item_type="document", extra="", doi=""):
    return {
        "key": "K1",
        "version": 5,
        "data": {"itemType": item_type, "title": title, "extra": extra, "DOI": doi},
    }


def test_plan_update_prefers_arxiv_over_title_query():
    calls = []

    def fake_fetch(kind, value):
        calls.append(kind)
        return {"title": f"from-{kind}"}

    action, upd = zm.plan_update(_item("paper_preprint_1304.4626.pdf"), fetcher=fake_fetch)
    assert action == "arxiv"
    assert upd == {"title": "from-arxiv"}
    assert calls == ["arxiv"]  # never fell through to title query


def test_plan_update_uses_doi_when_no_arxiv():
    def fake_fetch(kind, value):
        assert kind == "doi" and value == "10.1145/xyz"
        return {"title": "via-doi"}

    action, upd = zm.plan_update(_item("weird title", doi="10.1145/xyz"), fetcher=fake_fetch)
    assert action == "doi" and upd["title"] == "via-doi"


def test_plan_update_falls_back_to_title_query():
    title = "A Sufficiently Long And Descriptive Paper Title"
    action, upd = zm.plan_update(
        _item(title), fetcher=lambda kind, value: {"title": "via-title"}
    )
    assert action == "crossref-title" and upd["title"] == "via-title"


def test_plan_update_no_match_when_fetch_fails():
    action, upd = zm.plan_update(_item("short"), fetcher=lambda k, v: None)
    assert action == "no-match" and upd is None


# ── enrich_items orchestration (no network) ─────────────────────────


def test_enrich_items_dry_run(monkeypatch):
    items = [
        _item("paper_preprint_1304.4626.pdf"),
        _item("Already Good", item_type="journalArticle"),
    ]
    items[1]["data"]["creators"] = [{"creatorType": "author", "lastName": "X"}]
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: items)
    monkeypatch.setattr(zm, "update_item", lambda *a, **k: pytest.fail("dry-run must not write"))

    results = zm.enrich_items(
        "lib", "key", fetcher=lambda kind, v: {"title": "fixed"}, dry_run=True
    )
    assert len(results) == 1  # rich item skipped
    assert results[0].applied and results[0].detail == "fixed"


def test_enrich_items_empty_only_keys_enriches_nothing(monkeypatch):
    """An empty scope set must mean 'nothing' — never 'unscoped'."""
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: [_item("bare_document.pdf")])
    monkeypatch.setattr(zm, "update_item", lambda *a, **k: pytest.fail("must not write"))
    results = zm.enrich_items("lib", "key", only_keys=set(),
                              fetcher=lambda k, v: {"title": "x"})
    assert results == []


def test_enrich_items_reports_put_failure(monkeypatch):
    monkeypatch.setattr(zm, "iter_items",
                        lambda *a, **k: [_item("bare_document_with_long_title.pdf")])
    monkeypatch.setattr(zm, "update_item", lambda *a, **k: (False, "http 400: bad field"))
    results = zm.enrich_items("lib", "key", fetcher=lambda k, v: {"title": "x"})
    assert results[0].applied is False
    assert "400" in results[0].detail


# ── mirror_attachments ──────────────────────────────────────────────


def _attachment(key, parent, md5="abc", filename="p.pdf"):
    return {"key": key, "data": {"itemType": "attachment", "linkMode": "imported_file",
                                 "filename": filename, "md5": md5, "parentItem": parent}}


def test_mirror_scopes_to_registry_parents(monkeypatch, tmp_path):
    import hashlib

    content = b"%PDF-fake"
    md5 = hashlib.md5(content).hexdigest()
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: [
        _attachment("A1", "PARENT1", md5=md5),
        _attachment("A2", "PARENT2", md5=md5),
    ])
    monkeypatch.setattr(zm, "_request", lambda *a, **k: (200, content))
    results = zm.mirror_attachments("lib", "key", storage_dir=tmp_path,
                                    only_keys={"PARENT1"})
    assert len(results) == 1 and results[0].status == "downloaded"
    assert (tmp_path / "A1" / "p.pdf").read_bytes() == content


def test_mirror_rejects_md5_mismatch(monkeypatch, tmp_path):
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: [_attachment("A1", "P1", md5="deadbeef")])
    monkeypatch.setattr(zm, "_request", lambda *a, **k: (200, b"tampered"))
    results = zm.mirror_attachments("lib", "key", storage_dir=tmp_path)
    assert results[0].status == "error" and "md5" in results[0].detail
    assert not (tmp_path / "A1").exists()


def test_mirror_accepts_non_pdf_attachments(monkeypatch, tmp_path):
    """HTML snapshots etc. must not be rejected by magic-byte sniffing."""
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: [
        _attachment("A1", "P1", md5=None, filename="snap.html")])
    # md5=None -> no-file path; use a real md5 for the download path
    import hashlib

    body = b"<html>snapshot</html>"
    monkeypatch.setattr(zm, "iter_items", lambda *a, **k: [
        _attachment("A1", "P1", md5=hashlib.md5(body).hexdigest(), filename="snap.html")])
    monkeypatch.setattr(zm, "_request", lambda *a, **k: (200, body))
    results = zm.mirror_attachments("lib", "key", storage_dir=tmp_path)
    assert results[0].status == "downloaded"
