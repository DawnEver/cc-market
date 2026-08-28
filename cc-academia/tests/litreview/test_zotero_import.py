"""Tests for literature_review/export/zotero_import.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from academia.litreview.zotero import zotero_import as zi


# ── normalize_stem ──────────────────────────────────────────────────


def test_normalize_stem():
    assert zi.normalize_stem("CutCount_FOCS2011_1103.0534.pdf") == "cutcountfocs201111030534"
    assert zi.normalize_stem("A B/c-d e.pdf") == "cde"


# ── iter_workspace_pdfs ─────────────────────────────────────────────


def test_iter_workspace_pdfs_priority_and_excludes_ingest(tmp_path):
    for rel in ("download/pdfs", "papers", "pdfs", "ingest/x"):
        (tmp_path / rel).mkdir(parents=True)
    (tmp_path / "download/pdfs/b.pdf").write_bytes(b"%PDF")
    (tmp_path / "papers/a.pdf").write_bytes(b"%PDF")
    (tmp_path / "pdfs/c.pdf").write_bytes(b"%PDF")
    (tmp_path / "ingest/x/0-raw.pdf").write_bytes(b"%PDF")

    found = zi.iter_workspace_pdfs(tmp_path)
    by_name = {p.name: prio for p, prio in found}
    assert by_name == {"b.pdf": 0, "a.pdf": 1, "c.pdf": 2}


# ── group_pdfs ──────────────────────────────────────────────────────


def _mk(tmp_path, rel):
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"%PDF")
    return p


def test_group_pdfs_dedupes_by_doi_across_dirs(tmp_path):
    a = _mk(tmp_path, "papers/Ghahfarokhi_et_al_2022.pdf")
    b = _mk(tmp_path, "pdfs/ghahfarokhi2022_Hairpin Windings.pdf")
    c = _mk(tmp_path, "download/pdfs/other_1304.4626.pdf")

    fake_doi = {a: "10.X/a", b: "10.x/A", c: None}  # same DOI, different case
    files = [(p, prio) for p, prio in [(c, 0), (a, 1), (b, 2)]]
    groups = zi.group_pdfs(files, doi_of=fake_doi.get)

    assert len(groups) == 2
    doi_group = next(g for g in groups if g.doi)
    assert doi_group.canonical == a  # papers/ outranks pdfs/
    assert doi_group.duplicates == [b]
    fn_group = next(g for g in groups if not g.doi)
    assert fn_group.key == f"fn:{zi.normalize_stem(c.name)}"


def test_group_pdfs_same_dir_prefers_shorter_name(tmp_path):
    long = _mk(tmp_path, "papers/england2021_Evaluation_of_Winding_Symmetry.pdf")
    short = _mk(tmp_path, "papers/england2021.pdf")
    groups = zi.group_pdfs([(long, 1), (short, 1)], doi_of=lambda p: "10.Y/1")
    assert groups[0].canonical == short


def test_group_pdfs_merges_doi_less_twin_into_doi_group(tmp_path):
    """Same paper, two scans: one yields a DOI, the other doesn't — still one group."""
    a = _mk(tmp_path, "papers/england2021_Evaluation of Winding Symmetry.pdf")
    b = _mk(tmp_path, "papers/england2021_Evaluation_of_Winding_Symmetry.pdf")
    fake_doi = {a: "10.Y/2", b: None}
    groups = zi.group_pdfs([(a, 1), (b, 1)], doi_of=fake_doi.get)
    assert len(groups) == 1
    assert groups[0].doi == "10.Y/2"
    assert groups[0].duplicates == [b]


def test_title_key_falls_back_when_stripping_leaves_little():
    # 'AllSAT_TACAS2005' is author-year-shaped but the whole name is the title;
    # stripping must not reduce it to ''.
    assert zi.title_key("AllSAT_TACAS2005.pdf") == "allsattacas2005"
    assert zi.title_key("moggwalls2024_Automatic_Routing_of_Hairpin_End_Windings.pdf") == \
        "automaticroutingofhairpinendwindings"


def test_group_pdfs_merges_substring_stems_but_not_two_dois(tmp_path):
    a = _mk(tmp_path, "papers/moggwalls2024_Automatic_Routing_of_Hairpin_End_Windings.pdf")
    b = _mk(tmp_path, "papers/moggwalls2024_Development_of_a_Tool_for_Automatic_Routing_of_Hairpin_End_Windings.pdf")
    c = _mk(tmp_path, "papers/moggwalls2024_A_different_paper_on_Automatic_Routing_of_Hairpin_End_Windings.pdf")
    fake_doi = {a: None, b: "10.Z/3", c: "10.W/4"}
    groups = zi.group_pdfs([(a, 1), (b, 1), (c, 1)], doi_of=fake_doi.get)
    assert len(groups) == 2  # a merges into b; c stays separate (own DOI)
    doi_groups = [g for g in groups if g.doi]
    merged = next(g for g in doi_groups if g.doi == "10.Z/3")
    assert a in merged.duplicates


def test_group_pdfs_substring_merge_requires_same_author_year(tmp_path):
    """'smith2023_Attention...' must not merge into 'jones2024_...Attention...'."""
    a = _mk(tmp_path, "papers/smith2023_Attention.pdf")
    b = _mk(tmp_path, "papers/jones2024_A_Long_Survey_on_Attention_Mechanisms.pdf")
    groups = zi.group_pdfs([(a, 1), (b, 1)], doi_of=lambda p: None)
    assert len(groups) == 2


# ── build_item_template ─────────────────────────────────────────────


class FakeZot:
    def item_template(self, item_type):
        return {"itemType": item_type, "title": "", "creators": [], "tags": [],
                "collections": [], "relations": {}}


def test_build_item_template_with_doi(monkeypatch):
    monkeypatch.setattr(zi.zm, "fetch_crossref_doi", lambda doi: {
        "itemType": "journalArticle", "title": "Real Title",
        "creators": [{"creatorType": "author", "lastName": "Cygan", "firstName": "Marek"}],
        "DOI": doi, "date": "2011",
    })
    g = zi.PdfGroup(key="doi:10.z/1", canonical=Path("x.pdf"), duplicates=[], doi="10.z/1")
    tmpl = zi.build_item_template(FakeZot(), g)
    assert tmpl["itemType"] == "journalArticle"
    assert tmpl["title"] == "Real Title"
    assert tmpl["DOI"] == "10.z/1"


def test_build_item_template_without_doi_falls_back_to_document(monkeypatch):
    g = zi.PdfGroup(key="fn:x", canonical=Path("some_paper.pdf"), duplicates=[], doi=None)
    tmpl = zi.build_item_template(FakeZot(), g)
    assert tmpl["itemType"] == "document"
    assert tmpl["title"] == "some_paper"


# ── import dry-run / registry skip ──────────────────────────────────


def test_import_dry_run_touches_nothing(tmp_path):
    _mk(tmp_path, "papers/a.pdf")
    results = zi.import_workspace_pdfs(tmp_path, "lib", "key", dry_run=True)
    assert [r.action for r in results] == ["dry-run"]
    assert not (tmp_path / "zotero_registry.jsonl").exists()


def test_import_skips_registry_entries(tmp_path):
    _mk(tmp_path, "papers/a.pdf")
    (tmp_path / "zotero_registry.jsonl").write_text(
        '{"candidate_id": "a", "zotero_key": "ZZ", "pdf_attached": true}\n'
    )

    class NoCallZot:
        def __getattr__(self, name):
            pytest.fail(f"unexpected zotero call: {name}")

    results = zi.import_workspace_pdfs(tmp_path, "lib", "key", zot=NoCallZot())
    assert results[0].action == "skipped-registry"
    assert results[0].zotero_key == "ZZ"


# ── _candidate_matches ──────────────────────────────────────────────


def test_candidate_matches_truncated_filename_prefix():
    # full candidate id matches its 40-char truncated filename prefix
    stem = "S2-c5f3ab59b6383b4a333431200ce3ff773d964_Quantitative analysis.pdf"
    assert zi._candidate_matches(stem, {"S2-c5f3ab59b6383b4a333431200ce3ff773d964c4e"})
    # and the truncated filename token matches the full id
    assert zi._candidate_matches(
        "S2-c5f3ab59b6383b4a333431200ce3ff773d964_Quant.pdf",
        {"S2-c5f3ab59b6383b4a333431200ce3ff773d964c4e"},
    )


def test_candidate_matches_rejects_other_ids():
    stem = "S2-c5f3ab59b6383b4a333431200ce3ff773d964_Quant.pdf"
    assert not zi._candidate_matches(stem, {"S2-fd75c6d3637078c5070cb4986a528428e6cee349"})
    assert not zi._candidate_matches(stem, set())


def test_import_filters_by_candidate_ids(tmp_path):
    for name in (
        "S2-c5f3ab59b6383b4a333431200ce3ff773d964_Quant.pdf",
        "S2-fd75c6d3637078c5070cb4986a528428e6cee_Subdomain.pdf",
        "S2-34de9698ce8d5e8b20d9008d708ba332ee00f_Iter.pdf",
    ):
        _mk(tmp_path, f"papers/{name}")
    results = zi.import_workspace_pdfs(
        tmp_path, "lib", "key", dry_run=True,
        candidate_ids=["S2-c5f3ab59b6383b4a333431200ce3ff773d964c4e",
                       "S2-fd75c6d3637078c5070cb4986a528428e6cee349"],
    )
    assert len(results) == 2
    got = {r.canonical for r in results}
    assert any("c5f3ab59" in g for g in got)
    assert any("fd75c6d3" in g for g in got)
    assert not any("34de9698" in g for g in got)
