"""A brief's constraints must reach the provider, and no further than it can go.

Two failures live here, and they hid each other.

The first: `_query_kwargs` read the year range from the *query dict* only, so a
brief that declared ``year_from = 2000`` had no effect on any request. Every
date bound an operator wrote into a brief was decoration, and nothing said so.

The second: the same function forwarded ``content_types`` to every provider, and
the three that never declared it raised ``TypeError`` — recorded as a query
failure, which looks exactly like a query that found nothing. Fixing the first
without the second would have turned a silent no-op into a loud crash.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from academia.sources.base import PaperSource, SearchPage, accepted_search_kwargs

QUERY = """artifact_version = 1

[[queries]]
query_id = "Q1"
purpose = "one query"
expression = "alpha beta"
enabled = true
concept_ids = []
{extra}
"""


def write_topic(
    topic_dir: Path,
    *,
    query_extra: str = "",
    brief_constraints: str = "",
    plan_constraints: str = "",
    workspace_defaults: str = "",
    with_brief: bool = True,
) -> Path:
    plan = QUERY.format(extra=query_extra)
    if with_brief:
        plan = 'brief_ref = { path = "research_brief.toml" }\n\n' + plan
    if plan_constraints:
        plan += f"\n[constraints]\n{plan_constraints}\n"
    (topic_dir / "queries.toml").write_text(plan, encoding="utf-8")

    if with_brief:
        (topic_dir / "research_brief.toml").write_text(
            'artifact_version = 1\noriginal_request = "x"\n'
            f"\n[constraints]\n{brief_constraints}\n",
            encoding="utf-8",
        )

    if workspace_defaults:
        (topic_dir / "workspace.toml").write_text(
            f'workspace_id = "t"\nname = "T"\n\n[defaults]\n{workspace_defaults}\n',
            encoding="utf-8",
        )
    return topic_dir / "queries.toml"


def probe_url(monkeypatch, topic_dir: Path) -> str:
    """Run a real OpenAlex probe and hand back the URL it requested."""
    from academia.litreview.search import run_probe
    from academia.sources import openalex as source

    seen: dict[str, str] = {}

    def get(url, name, **kwargs):
        seen["url"] = url
        return {"results": [], "meta": {"count": 0}}

    monkeypatch.setattr(source, "get_json", get)
    code = run_probe(
        queries_path=topic_dir / "queries.toml",
        out_dir=topic_dir,
        provider=source.OpenAlex(),
        allow_unapproved_plan=True,
    )
    assert code == 0, "the probe itself must not have failed"
    return seen["url"]


# ---------------------------------------------------------------------------
# Constraints reach the request
# ---------------------------------------------------------------------------


def test_brief_constraints_become_the_default_year_range(tmp_path, monkeypatch):
    write_topic(tmp_path, brief_constraints='year_from = 2015\nyear_to = 2021')

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2015-01-01" in url
    assert "to_publication_date%3A2021-12-31" in url


def test_a_query_year_overrides_the_brief(tmp_path, monkeypatch):
    write_topic(
        tmp_path,
        query_extra="year_from = 2020\n",
        brief_constraints="year_from = 2015",
    )

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2020-01-01" in url
    assert "2015" not in url


def test_queries_toml_constraints_outrank_the_brief(tmp_path, monkeypatch):
    """The plan's own table is inside the approval hash, so it is the signed one."""
    write_topic(
        tmp_path,
        brief_constraints="year_from = 2015",
        plan_constraints="year_from = 2019",
    )

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2019-01-01" in url
    assert "2015" not in url


def test_workspace_defaults_are_the_last_resort(tmp_path, monkeypatch):
    """Before this, nothing read ``[defaults]`` at all."""
    write_topic(tmp_path, workspace_defaults="year_from = 2016")

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2016-01-01" in url


def test_the_brief_wins_over_workspace_defaults(tmp_path, monkeypatch):
    write_topic(
        tmp_path,
        workspace_defaults="year_from = 2016",
        brief_constraints="year_from = 2011",
    )

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2011-01-01" in url
    assert "2016" not in url


def test_a_plan_without_a_brief_still_gets_workspace_defaults(tmp_path, monkeypatch):
    """No ``brief_ref`` must not mean no defaults."""
    write_topic(tmp_path, with_brief=False, workspace_defaults="year_from = 2016")

    url = probe_url(monkeypatch, tmp_path)

    assert "from_publication_date%3A2016-01-01" in url


def test_no_constraints_anywhere_means_no_date_filter(tmp_path, monkeypatch):
    write_topic(tmp_path, with_brief=False)

    url = probe_url(monkeypatch, tmp_path)

    assert "publication_date" not in url


# ---------------------------------------------------------------------------
# Constraints stop where the provider stops
# ---------------------------------------------------------------------------


def test_a_kwarg_the_provider_cannot_take_is_dropped_not_raised(tmp_path, monkeypatch, capsys):
    """The regression for the TypeError: OpenAlex has no content-type filter."""
    write_topic(tmp_path, brief_constraints='content_types = ["Journals"]')

    url = probe_url(monkeypatch, tmp_path)  # must not raise

    assert "content_types" not in url
    assert "does not accept content_types" in capsys.readouterr().out


def test_the_drop_is_recorded_in_the_artifacts(tmp_path, monkeypatch, capsys):
    """Loud means recorded, not merely printed: the audit must say so too."""
    write_topic(tmp_path, brief_constraints='content_types = ["Journals"]')
    probe_url(monkeypatch, tmp_path)
    capsys.readouterr()

    audit = tmp_path / "probe" / "openalex" / "probe_audit.log"
    row = json.loads(audit.read_text(encoding="utf-8").splitlines()[0])
    assert row["dropped_kwargs"] == ["content_types"]


def test_the_same_drop_is_announced_once_not_per_query(tmp_path, monkeypatch, capsys):
    queries = "".join(
        f'\n[[queries]]\nquery_id = "Q{i}"\npurpose = "p"\n'
        f'expression = "alpha beta"\nenabled = true\nconcept_ids = []\n'
        for i in (1, 2, 3)
    )
    (tmp_path / "queries.toml").write_text(
        "artifact_version = 1\n"
        + queries
        + '\n[constraints]\ncontent_types = ["Journals"]\n',
        encoding="utf-8",
    )
    from academia.litreview.search import run_probe
    from academia.sources import openalex as source

    monkeypatch.setattr(source, "get_json", lambda url, name, **kw: {"results": [], "meta": {}})
    run_probe(
        queries_path=tmp_path / "queries.toml",
        out_dir=tmp_path,
        provider=source.OpenAlex(),
        allow_unapproved_plan=True,
    )

    assert capsys.readouterr().out.count("does not accept") == 1


def test_search_scope_is_never_forwarded(tmp_path, monkeypatch):
    """No source has ever accepted it, so it was only ever a way to fail."""
    write_topic(tmp_path, query_extra="search_scope = \"title\"\n")

    url = probe_url(monkeypatch, tmp_path)

    assert "search_scope" not in url


# ---------------------------------------------------------------------------
# The invariant a new source must satisfy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["openalex", "ieee", "semantic_scholar", "arxiv", "dblp"])
def test_every_source_accepts_the_year_bounds(name):
    """Otherwise a brief's date range is silently discarded for that source."""
    from academia.sources import get_source

    accepted = accepted_search_kwargs(get_source(name))

    assert accepted is not None, f"{name}.search takes **kwargs; add an explicit signature"
    assert {"year_from", "year_to"} <= accepted


def test_a_source_with_var_keyword_accepts_anything():
    class Anything(PaperSource):
        request_delay = 0.0

        @property
        def name(self) -> str:
            return "anything"

        def search(self, expression, query_id, **kwargs) -> SearchPage:
            return SearchPage(source="anything", query_id=query_id, page=1, total_count=0)

    assert accepted_search_kwargs(Anything()) is None


def test_a_source_is_filtered_against_its_own_signature():
    applied: list[dict[str, Any]] = []

    class Narrow(PaperSource):
        request_delay = 0.0

        @property
        def name(self) -> str:
            return "narrow"

        # No **kwargs: this is the shape that made the filter necessary.
        def search(self, expression, query_id, *, year_from=None) -> SearchPage:
            return SearchPage(source="narrow", query_id=query_id, page=1, total_count=0)

    from academia.litreview.search import _query_kwargs

    kwargs, dropped = _query_kwargs(
        {"year_from": 2010, "content_types": ["Journals"]},
        defaults={},
        provider=Narrow(),
    )

    assert applied == []
    assert kwargs == {"year_from": 2010}
    assert dropped == ["content_types"]


def test_page_and_timeout_are_not_query_options():
    """Forwarding one of these would be a duplicate-keyword TypeError."""
    from academia.litreview.search import QUERY_OPTION_KEYS

    for reserved in ("page", "per_page", "timeout", "query_id", "expression"):
        assert reserved not in QUERY_OPTION_KEYS
