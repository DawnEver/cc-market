"""The evidence papers are part of the deliverable, not supporting material.

An editor picking reviewers from a broad list reads the work that qualifies each
one. That means every piece of evidence has to be reachable — a title and a
similarity score are not enough to open a paper with.
"""

from __future__ import annotations

import pytest

from academia.core.models import Author, Paper
from academia.reviewer import discover, report
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    connection = db.connect(tmp_path / "r.db")
    yield connection
    connection.close()


def _store(conn, paper_id, **kwargs):
    paper = Paper(paper_id=paper_id, source="openalex", title=f"Work {paper_id}", year=2024, **kwargs)
    paper.authors = [Author(name="Ada Author", idx=0, openalex_id="A1")]
    repo.ingest_paper(conn, paper)
    return paper


def test_evidence_links_to_the_open_access_landing_page(conn):
    _store(conn, "p1", doi="10.1109/x", landing_page_url="https://doi.org/10.1109/x")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)

    assert candidates[0].evidence[0].url == "https://doi.org/10.1109/x"


def test_evidence_falls_back_to_a_doi_link(conn):
    _store(conn, "p1", doi="10.1109/y")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)

    assert candidates[0].evidence[0].url == "https://doi.org/10.1109/y"


def test_evidence_without_a_doi_has_no_invented_link(conn):
    _store(conn, "p1")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)

    assert candidates[0].evidence[0].url == ""


def test_the_dossier_renders_evidence_as_a_link(conn):
    _store(conn, "p1", doi="10.1109/z", landing_page_url="https://publisher/z")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)
    rows = report.build_rows(candidates)

    dossier = report.render_dossier(conn, rows[0])

    assert "[Work p1](https://publisher/z)" in dossier


def test_the_shortlist_points_at_the_dossier_holding_the_papers(conn):
    _store(conn, "p1", doi="10.1109/z")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)
    rows = report.build_rows(candidates)

    assert "dossiers/" in rows[0].evidence_text


def test_a_reading_list_collects_the_papers_behind_the_shortlist(conn):
    """The editor reads the literature, so it is worth assembling once."""
    _store(conn, "p1", doi="10.1109/a", landing_page_url="https://a")
    _store(conn, "p2", doi="10.1109/b")
    candidates = discover.build_candidates(conn, {"p1": 0.9, "p2": 0.5}, min_evidence=1)
    rows = report.build_rows(candidates)

    markdown = report.render_reading_list(rows)

    # Most relevant first, each reachable, listed once however many cite it.
    assert markdown.index("Work p1") < markdown.index("Work p2")
    assert "https://a" in markdown
    assert "https://doi.org/10.1109/b" in markdown
    assert markdown.count("Work p1") == 1


def test_a_papers_link_survives_the_candidates_file(conn):
    """report rebuilds evidence from candidates.jsonl, so the link must persist.

    It did not, and every entry in the first real reading list read
    "no link available" while the store held the DOI all along.
    """
    _store(conn, "p1", doi="10.1109/z", landing_page_url="https://publisher/z")
    candidates = discover.build_candidates(conn, {"p1": 0.9}, min_evidence=1)

    restored = candidates[0].evidence[0].as_dict()

    assert restored["url"] == "https://publisher/z"
    assert restored["doi"] == "10.1109/z"
