from academia.core.models import Paper
from academia.reviewer.discover import run_search
from academia.reviewer.profile import Profile, Query
from academia.sources.base import SearchPage


class Source:
    request_delay = 0
    max_retries = 1

    def __init__(self, name, papers):
        self.name = name
        self.papers = papers

    def search_pages(self, expression, query_id, **kwargs):
        return [SearchPage(self.name, query_id, 1, len(self.papers), self.papers)]


def test_search_reports_unique_paper_counts_per_source():
    shared = Paper.build(title="Shared paper", source="openalex", doi="10.1/shared")
    oa_only = Paper.build(title="OpenAlex paper", source="openalex", doi="10.1/oa")
    s2_copy = Paper.build(title="Shared paper", source="semantic_scholar", doi="10.1/shared")
    s2_only = Paper.build(title="S2 paper", source="semantic_scholar", doi="10.1/s2")
    profile = Profile(
        manuscript_id="m",
        title_hash="hash",
        journal="tie",
        year=2026,
        queries=[Query("q1", "motors")],
    )

    outcome = run_search(
        [Source("openalex", [shared, oa_only]), Source("semantic_scholar", [s2_copy, s2_only])],
        profile,
    )

    assert outcome.per_source == {"openalex": 2, "semantic_scholar": 2}
    assert len(outcome.papers) == 3
