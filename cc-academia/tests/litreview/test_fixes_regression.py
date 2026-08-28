"""Regression tests for the architecture-review fixes.

Covers:
1. Multi-provider search isolation (raw files, probe files, candidates).
2. Failure collection instead of silent swallowing.
3. `lit-review ingest --paper` selection actually reaching decompose_pdfs.
4. BibTeX export with real metadata + escaping.
5. Workspace root resolution (env var / walk-up).
6. Provider registry aliases.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from academia.core.errors import UsageError
from academia.core.models import Author, Paper, position_label
from academia.sources.base import PaperSource, SearchPage

# ---------------------------------------------------------------------------
# Fakes & fixtures
# ---------------------------------------------------------------------------

class FakeSource(PaperSource):
    """In-memory source returning canned papers."""

    request_delay = 0.0

    def __init__(self, name: str, records: list[dict[str, Any]], fail: bool = False):
        self._name = name
        self._records = records
        self._fail = fail

    @property
    def name(self) -> str:
        return self._name

    def _papers(self) -> list[Paper]:
        papers = []
        for record in self._records:
            paper = Paper.build(
                title=record["title"],
                source=self._name,
                doi=record.get("doi", ""),
                source_id=record["id"],
            )
            paper.authors = [Author(name="Someone", idx=0, position=position_label(0, 1))]
            papers.append(paper)
        return papers

    def search(self, expression, query_id, *, page=1, per_page=25, **kwargs) -> SearchPage:
        if self._fail:
            raise RuntimeError(f"{self._name} exploded")
        papers = self._papers() if page == 1 else []
        return SearchPage(
            source=self._name,
            query_id=query_id,
            page=page,
            total_count=len(self._records),
            papers=papers,
            raw={"records": self._records},
        )


@pytest.fixture
def topic_dir(tmp_path: Path) -> Path:
    td = tmp_path / "workspaces" / "test-topic"
    td.mkdir(parents=True)
    (td / "workspace.toml").write_text(
        'workspace_id = "test-topic"\nname = "Test"\nproviders = ["fake_a", "fake_b"]\n',
        encoding="utf-8",
    )
    (td / "research_brief.toml").write_text(
        'brief_id = "b1"\noriginal_request = "test"\nresearch_objective = "test"\n',
        encoding="utf-8",
    )
    (td / "queries.toml").write_text(
        '[[queries]]\n'
        'query_id = "q1"\npurpose = "core"\nexpression = "llc converter"\nenabled = true\n',
        encoding="utf-8",
    )
    return td


@pytest.fixture
def fake_registry(monkeypatch):
    """Install fake providers into the registry; return the record sets."""
    import academia.sources as sources_pkg

    recs_a = [
        {"id": "1", "title": "Paper A1", "doi": "10.1/a1"},
        {"id": "2", "title": "Paper A2", "doi": "10.1/a2"},
    ]
    recs_b = [
        {"id": "1", "title": "Paper B1", "doi": "10.1/b1"},
        {"id": "2", "title": "Paper B2", "doi": "10.1/b2"},
    ]
    monkeypatch.setitem(sources_pkg.SOURCE_FACTORIES, "fake_a", lambda: FakeSource("fake_a", recs_a))
    monkeypatch.setitem(sources_pkg.SOURCE_FACTORIES, "fake_b", lambda: FakeSource("fake_b", recs_b))
    monkeypatch.setitem(sources_pkg.SOURCE_FACTORIES, "fake_boom", lambda: FakeSource("fake_boom", [], fail=True))
    return {"fake_a": recs_a, "fake_b": recs_b}


# ---------------------------------------------------------------------------
# 1+2. Multi-provider search
# ---------------------------------------------------------------------------

def test_multi_provider_search_no_overwrite_no_dup(topic_dir, fake_registry):
    from academia.litreview.workflow_search import run_search

    result = run_search(topic_dir, provider=["fake_a", "fake_b"], skip_probe=True)

    assert result["candidates_count"] == 4, "each provider's records must survive, no dup/overwrite"

    ranked = [
        json.loads(line)
        for line in (topic_dir / "search" / "candidates_ranked.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    by_provider: dict[str, int] = {}
    for row in ranked:
        by_provider[row["source_provider"]] = by_provider.get(row["source_provider"], 0) + 1
    assert by_provider == {"fake_a": 2, "fake_b": 2}

    raw_root = topic_dir / "search" / "search" / "raw"
    assert (raw_root / "fake_a").is_dir(), "raw responses must be namespaced per provider"
    assert (raw_root / "fake_b").is_dir()


def test_multi_provider_probe_isolated_and_evaluated(topic_dir, fake_registry):
    from academia.litreview.workflow_search import run_search

    result = run_search(topic_dir, provider=["fake_a", "fake_b"], skip_probe=False)

    probe_root = topic_dir / "search" / "probe"
    assert (probe_root / "fake_a" / "probe_results.jsonl").is_file()
    assert (probe_root / "fake_b" / "probe_results.jsonl").is_file()
    assert result["candidates_count"] == 4


def test_provider_failure_is_collected_not_swallowed(topic_dir, fake_registry):
    from academia.litreview.workflow_search import run_search

    result = run_search(topic_dir, provider=["fake_a", "fake_boom"], skip_probe=True)

    assert result["candidates_count"] == 2, "healthy provider still delivers"
    assert result["failures"], "failing provider must be reported in result['failures']"
    assert any("fake_boom" in f.get("provider", "") for f in result["failures"])


# ---------------------------------------------------------------------------
# 3. Ingest paper selection
# ---------------------------------------------------------------------------

def test_decompose_pdfs_filters_by_candidate_ids(tmp_path):
    from academia.litreview.ingest_pipeline import decompose_pdfs

    manifest = {
        "manifest_id": "m1",
        "papers": [
            {"candidate_id": "p1", "pdf_path": str(tmp_path / "missing1.pdf"), "sha256": ""},
            {"candidate_id": "p2", "pdf_path": str(tmp_path / "missing2.pdf"), "sha256": ""},
        ],
    }
    mpath = tmp_path / "manifest.json"
    mpath.write_text(json.dumps(manifest), encoding="utf-8")

    artifact = decompose_pdfs(mpath, tmp_path, confirmed_by_user=True, candidate_ids=["p1"])

    processed = [i["candidate_id"] for i in artifact["ingests"]]
    assert processed == ["p1"], "only requested papers may be decomposed"


def test_run_ingest_passes_pending_selection(topic_dir, monkeypatch):
    from academia.litreview import ingest_pipeline as ingest_mod
    from academia.litreview.workflow_ingest import run_ingest

    handoff = topic_dir / "handoff"
    handoff.mkdir(exist_ok=True)
    (handoff / "download_manifest.json").write_text(json.dumps({
        "manifest_id": "m1",
        "papers": [
            {"candidate_id": "p1", "pdf_path": "x.pdf", "sha256": ""},
            {"candidate_id": "p2", "pdf_path": "y.pdf", "sha256": ""},
        ],
    }), encoding="utf-8")

    seen: dict[str, Any] = {}

    def fake_decompose(manifest_path, run_dir, confirmed_by_user, candidate_ids=None):
        seen["candidate_ids"] = candidate_ids
        return {"ingests": [{"candidate_id": c, "status": "succeeded"} for c in (candidate_ids or [])]}

    monkeypatch.setattr(ingest_mod, "decompose_pdfs", fake_decompose)

    result = run_ingest(topic_dir, paper_ids=["p1"])

    assert seen["candidate_ids"] == ["p1"], "--paper selection must reach decompose_pdfs"
    assert result["succeeded"] == 1


# ---------------------------------------------------------------------------
# 4. BibTeX export
# ---------------------------------------------------------------------------

def test_bibtex_export_uses_candidate_metadata(topic_dir):
    from academia.litreview.workflow_export import run_export

    search_dir = topic_dir / "search"
    search_dir.mkdir(exist_ok=True)
    (search_dir / "candidates_ranked.jsonl").write_text(json.dumps({
        "candidate_id": "IEEE-1",
        "title": "Gain & Efficiency of LLC",
        "authors": ["Zhang, Wei", "Li, Ming"],
        "venue": "IEEE Transactions on Power Electronics",
        "publication_year": 2024,
        "doi": "10.1109/tpel.2024.1",
        "content_type": "Journals",
    }) + "\n", encoding="utf-8")

    reading = topic_dir / "reading"
    reading.mkdir(exist_ok=True)
    (reading / "IEEE-1_card.json").write_text(json.dumps({
        "candidate_id": "IEEE-1",
        "title": "Gain & Efficiency of LLC",
        "one_sentence": "An LLC study.",
    }), encoding="utf-8")

    out = run_export(topic_dir, format="bibtex")
    text = out.read_text(encoding="utf-8")

    assert "author = {Zhang, Wei and Li, Ming}" in text
    assert "year = {2024}" in text
    assert "journal = {IEEE Transactions on Power Electronics}" in text
    assert "doi = {10.1109/tpel.2024.1}" in text
    assert r"Gain \& Efficiency" in text, "LaTeX specials must be escaped"


# ---------------------------------------------------------------------------
# 5. Workspace root resolution
# ---------------------------------------------------------------------------

def test_workspaces_root_follows_the_data_root_setting(tmp_path, monkeypatch):
    """`find_root` walked up looking for a project marker.

    Shipped as a plugin there is no such tree, so the workspace location is a
    user setting instead.
    """
    from academia.core.paths import workspaces_root

    monkeypatch.setenv("ACADEMIA_DATA_ROOT", str(tmp_path))
    assert workspaces_root("literature-review") == tmp_path / "literature-review"


def test_workspaces_root_separates_workflows(tmp_path, monkeypatch):
    from academia.core.paths import workspaces_root

    monkeypatch.setenv("ACADEMIA_DATA_ROOT", str(tmp_path))
    assert workspaces_root("literature-review") != workspaces_root("reviewer-discovery")


# ---------------------------------------------------------------------------
# 6. Source registry
# ---------------------------------------------------------------------------

def test_get_source_aliases():
    from academia.sources import get_source

    assert get_source("ieee").name == get_source("ieee_xplore").name
    assert get_source("s2").name == get_source("semantic_scholar").name
    with pytest.raises(UsageError):
        get_source("nope")
