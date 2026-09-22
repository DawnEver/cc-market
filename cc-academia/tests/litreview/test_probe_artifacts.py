"""A probe that could not reach the source must never be recorded as success.

The failure this file exists for: `PaperSource.probe` reports a dead source as a
*value* (`Probe(total_count=0, failure_reason="http_429")`) rather than an
exception, and `run_probe` used to write `"status": "success"` as a literal no
data could contradict. An operator whose API quota was spent therefore saw a
page of queries that each looked like they had matched nothing, which is
indistinguishable from a literature that does not exist — the most expensive
possible misreading of a prior-art search.

The reader contract these tests pin:

* every artifact agrees about a query's verdict;
* a failure carries its reason, in all of them;
* an account-level failure stops the run instead of being repeated per query.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from academia.core.errors import EXIT_SOURCE, SourceError
from academia.sources.base import PaperSource, SearchPage

QUERIES = """artifact_version = 1

[[queries]]
query_id = "{qid}"
purpose = "query {qid}"
expression = "alpha beta"
enabled = true
concept_ids = []
"""


class ScriptedSource(PaperSource):
    """A source that answers each probe from a script, then repeats the last."""

    request_delay = 0.0

    def __init__(self, name: str, outcomes: list[Exception | None]):
        self._name = name
        self._outcomes = outcomes
        self.calls = 0

    @property
    def name(self) -> str:
        return self._name

    def search(self, expression, query_id, *, page=1, per_page=25, **kwargs) -> SearchPage:
        outcome = self._outcomes[min(self.calls, len(self._outcomes) - 1)]
        self.calls += 1
        if outcome is not None:
            raise outcome
        return SearchPage(
            source=self._name,
            query_id=query_id,
            page=page,
            total_count=7,
            papers=[],
            raw={"records": []},
        )


def quota_error() -> SourceError:
    return SourceError("http_429", "scripted", {"status": 429})


def write_plan(topic_dir: Path, qids: list[str]) -> Path:
    plan = topic_dir / "queries.toml"
    plan.write_text("".join(QUERIES.format(qid=q) for q in qids), encoding="utf-8")
    return plan


def probe(topic_dir: Path, provider: PaperSource, **kwargs) -> int:
    from academia.litreview.search import run_probe

    return run_probe(
        queries_path=topic_dir / "queries.toml",
        out_dir=topic_dir,
        provider=provider,
        allow_unapproved_plan=True,
        **kwargs,
    )


def artifacts(topic_dir: Path, provider_name: str) -> dict[str, list[dict]]:
    """Every recorded row, keyed by artifact name."""
    probe_dir = topic_dir / "probe" / provider_name

    def jsonl(name: str) -> list[dict]:
        path = probe_dir / name
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def csv_rows(name: str) -> list[dict]:
        path = probe_dir / name
        if not path.exists():
            return []
        with path.open(encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))

    return {
        "audit": jsonl("probe_audit.log"),
        "results": jsonl("probe_results.jsonl"),
        "errors": jsonl("errors.jsonl"),
        "summary": csv_rows("probe_summary.csv"),
    }


# ---------------------------------------------------------------------------
# The core regression
# ---------------------------------------------------------------------------


def test_a_rate_limited_probe_is_recorded_as_failed_not_success(tmp_path):
    """Every artifact must agree, and none of them may say the query succeeded."""
    write_plan(tmp_path, ["Q1"])
    assert probe(tmp_path, ScriptedSource("scripted", [quota_error()])) == EXIT_SOURCE

    rows = artifacts(tmp_path, "scripted")

    assert [r["status"] for r in rows["audit"]] == ["failed"]
    assert [r["status"] for r in rows["results"]] == ["failed"]
    assert [r["status"] for r in rows["summary"]] == ["failed"]

    for artifact in ("audit", "results", "summary"):
        assert rows[artifact][0]["failure_reason"] == "http_429", artifact
        assert "success" not in json.dumps(rows[artifact]), artifact

    assert rows["audit"][0]["http_status"] == 429
    assert rows["summary"][0]["http_status"] == "429"


def test_a_successful_probe_records_success_and_no_reason(tmp_path):
    """The other half of the contract: a clean run must not look like a failure."""
    write_plan(tmp_path, ["Q1"])
    assert probe(tmp_path, ScriptedSource("scripted", [None])) == 0

    rows = artifacts(tmp_path, "scripted")

    assert [r["status"] for r in rows["audit"]] == ["success"]
    assert [r["status"] for r in rows["summary"]] == ["success"]
    assert rows["audit"][0]["result_count"] == 7
    assert not rows["audit"][0]["failure_reason"]
    assert rows["errors"] == []


def test_status_is_one_vocabulary_across_the_two_paths(tmp_path):
    """An exception and a reported failure must not be typed differently.

    They used to be: the exception path wrote the integer ``0`` and the
    reported-failure path wrote the string ``"success"``, so a reader could not
    filter the artifact without knowing which branch had produced each row.
    """
    write_plan(tmp_path, ["Q1"])
    probe(tmp_path, ScriptedSource("scripted", [SourceError("non_json_response", "s", {})]))

    statuses = {r["status"] for r in artifacts(tmp_path, "scripted")["audit"]}
    assert statuses == {"failed"}


# ---------------------------------------------------------------------------
# Stopping: an account failure repeats, so do not pay for it once per query
# ---------------------------------------------------------------------------


def test_an_account_failure_aborts_instead_of_probing_every_query(tmp_path):
    write_plan(tmp_path, ["Q1", "Q2", "Q3"])
    source = ScriptedSource("scripted", [quota_error()])

    assert probe(tmp_path, source) == EXIT_SOURCE
    assert source.calls == 1, "a spent quota must not be re-probed per query"

    rows = {r["query_id"]: r for r in artifacts(tmp_path, "scripted")["results"]}
    assert rows["Q1"]["status"] == "failed"
    for qid in ("Q2", "Q3"):
        assert rows[qid]["status"] == "not_probed"
        assert rows[qid]["failure_reason"] == "http_429"


def test_a_query_level_failure_does_not_abort_the_run(tmp_path):
    """Only account failures stop a run — a malformed response is one query's problem."""
    write_plan(tmp_path, ["Q1", "Q2"])
    source = ScriptedSource("scripted", [SourceError("non_json_response", "s", {}), None])

    assert probe(tmp_path, source) == 1
    assert source.calls == 2

    rows = {r["query_id"]: r for r in artifacts(tmp_path, "scripted")["results"]}
    assert rows["Q1"]["status"] == "failed"
    assert rows["Q2"]["status"] == "success"


def test_a_forbidden_response_also_aborts(tmp_path):
    """A rejected key is the same class of failure as a spent budget."""
    write_plan(tmp_path, ["Q1", "Q2"])
    source = ScriptedSource("scripted", [SourceError("http_403", "s", {"status": 403})])

    assert probe(tmp_path, source) == EXIT_SOURCE
    assert source.calls == 1


def test_every_artifact_is_written_even_when_the_run_aborts(tmp_path):
    """The abort path must still leave a readable record of all queries."""
    write_plan(tmp_path, ["Q1", "Q2"])
    probe(tmp_path, ScriptedSource("scripted", [quota_error()]))

    rows = artifacts(tmp_path, "scripted")
    assert len(rows["audit"]) == 2
    assert len(rows["results"]) == 2
    assert len(rows["summary"]) == 2


# ---------------------------------------------------------------------------
# Reading the reason back
# ---------------------------------------------------------------------------


def test_failure_reasons_reads_back_what_the_run_recorded(tmp_path):
    from academia.litreview.search import failure_reasons

    write_plan(tmp_path, ["Q1"])
    probe(tmp_path, ScriptedSource("scripted", [quota_error()]))

    path = tmp_path / "probe" / "scripted" / "probe_results.jsonl"
    assert failure_reasons(path) == ["http_429"]


def test_failure_reasons_is_empty_for_a_clean_run(tmp_path):
    from academia.litreview.search import failure_reasons

    write_plan(tmp_path, ["Q1"])
    probe(tmp_path, ScriptedSource("scripted", [None]))

    path = tmp_path / "probe" / "scripted" / "probe_results.jsonl"
    assert failure_reasons(path) == []


def test_failure_reasons_tolerates_a_missing_file(tmp_path):
    from academia.litreview.search import failure_reasons

    assert failure_reasons(tmp_path / "nothing-here.jsonl") == []


@pytest.mark.parametrize("status", [401, 402, 403, 429])
def test_account_statuses_are_the_ones_that_stop_a_run(status):
    from academia.core.http import ACCOUNT_STATUSES

    assert status in ACCOUNT_STATUSES
