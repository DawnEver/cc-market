"""Retry policy and deserialisation hardening (regressions SR-007..022).

Ported from the pre-migration suite. The retry loop moved from a provider base
class into ``core.http`` plus ``PaperSource.search_pages``, but the guarantees
are the same: a transient failure buys another attempt, a permanent one does not.
"""

from __future__ import annotations

import json

import pytest

from academia.core.errors import SourceError
from academia.sources.base import PaperSource, SearchPage


class ScriptedSource(PaperSource):
    """A source whose search raises a scripted sequence of failures."""

    request_delay = 0.0

    def __init__(self, script: list[Exception | None]):
        self._script = list(script)
        self.calls = 0

    @property
    def name(self) -> str:
        return "scripted"

    def search(self, expression, query_id, *, page=1, per_page=25, **kwargs) -> SearchPage:
        self.calls += 1
        step = self._script.pop(0) if self._script else None
        if step is not None:
            raise step
        return SearchPage(source=self.name, query_id=query_id, page=page, total_count=1, papers=[])


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    import academia.core.http as http_mod

    monkeypatch.setattr(http_mod.time, "sleep", lambda _s: None)


def test_transient_errors_are_retried():
    source = ScriptedSource([ConnectionError("reset"), TimeoutError("slow"), None])
    pages = source.search_pages("x", "q1", max_pages=1)
    assert source.calls == 3
    assert pages[0].total_count == 1


def test_permanent_errors_fail_fast():
    source = ScriptedSource([ValueError("malformed query"), None])
    with pytest.raises(ValueError):
        source.search_pages("x", "q1", max_pages=1)
    assert source.calls == 1, "permanent failures must not be retried"


def test_source_error_with_transient_status_is_retried():
    error = SourceError("rate limited", "scripted", {"status": 429})
    source = ScriptedSource([error, None])
    assert source.search_pages("x", "q1", max_pages=1)[0].total_count == 1
    assert source.calls == 2


def test_source_error_with_permanent_status_fails_fast():
    error = SourceError("bad key", "scripted", {"status": 403})
    source = ScriptedSource([error, None])
    with pytest.raises(SourceError):
        source.search_pages("x", "q1", max_pages=1)
    assert source.calls == 1


def test_probe_reports_a_failure_instead_of_raising():
    """A probe exists to judge a query; a dead source is an answer, not a crash."""
    source = ScriptedSource([SourceError("http_429", "scripted", {"status": 429})])
    probe = source.probe("x", "q1")
    assert probe.failure_reason == "http_429"
    assert probe.total_count == 0


# ---------------------------------------------------------------------------
# Deserialisation
# ---------------------------------------------------------------------------


def test_from_dict_missing_required_field_raises_clear_error():
    from academia.litreview.models import Candidate

    with pytest.raises(ValueError, match=r"Candidate.*candidate_id"):
        Candidate.from_dict({"title": "T", "source_provider": "x"})


def test_run_stats_skips_malformed_rows(tmp_path, monkeypatch):
    """One bad candidate row must not abort plotting (SR-011)."""
    from academia.litreview import workflow_export

    topic_dir = tmp_path / "t"
    (topic_dir / "search").mkdir(parents=True)
    rows = [
        {"candidate_id": "a", "source_provider": "p", "title": "A", "publication_year": 2024},
        {"title": "missing required ids"},
    ]
    (topic_dir / "search" / "candidates_ranked.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8"
    )
    (topic_dir / "reading").mkdir(parents=True, exist_ok=True)

    result = workflow_export.run_stats(topic_dir, plots=False)
    assert result["total_candidates"] == 2
