"""Find candidates by walking papers, never by asking for names.

The whole pipeline rests on one rule: a reviewer is discovered as the author of
work that is demonstrably close to the submission. Asking a model to "suggest ten
experts" produces plausible names with no evidence behind them, and a live probe
showed even a name *search* is unreliable — querying a common name returned a
researcher from a completely unrelated field.

    submission -> queries -> related papers -> authorships -> candidates
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from academia.core import log
from academia.core.models import Paper
from academia.core.text import dedupe_records, recency_score, term_overlap, tokenize
from academia.reviewer.profile import Profile
from academia.reviewer.rank import Candidate, Evidence
from academia.sources.base import PaperSource
from academia.store import repository as repo

#: Relevance weights. Embedding similarity is optional; when it is unavailable
#: the remaining weights are renormalised rather than silently scoring lower.
RELEVANCE_WEIGHTS = {
    "bm25": 0.30,
    "terms": 0.20,
    "recency": 0.10,
    "embedding": 0.40,
}

DEFAULT_CANDIDATE_POOL = 300
DEFAULT_TOP_PAPERS = 50


@dataclass
class SearchOutcome:
    papers: list[Paper]
    per_query: dict[str, int]
    per_source: dict[str, int]
    failures: dict[str, str]


def run_search(
    sources: list[PaperSource],
    profile: Profile,
    *,
    max_pages: int = 2,
    per_page: int = 25,
    year_from: int | None = None,
) -> SearchOutcome:
    """Execute every query against every source and merge the results.

    A source that fails is recorded and skipped; losing IEEE must not abort a run
    that OpenAlex can still serve.
    """
    collected: list[dict[str, Any]] = []
    per_query: dict[str, int] = {}
    failures: dict[str, str] = {}
    papers_by_key: dict[str, Paper] = {}
    paper_ids_by_source: dict[str, set[str]] = {source.name: set() for source in sources}

    for source in sources:
        for query in profile.queries:
            key = f"{source.name}:{query.query_id}"
            try:
                pages = source.search_pages(
                    query.expression,
                    query.query_id,
                    max_pages=max_pages,
                    per_page=per_page,
                    year_from=year_from,
                )
            except Exception as error:
                failures[key] = str(error)
                log.warn(f"{key} failed: {error}")
                continue

            found = [paper for page in pages for paper in page.papers]
            per_query[key] = len(found)
            for paper in found:
                paper_ids_by_source[source.name].add(paper.paper_id)
                papers_by_key[paper.paper_id] = paper
                collected.append(
                    {
                        "paper_id": paper.paper_id,
                        "doi": paper.doi,
                        "title": paper.title,
                        "year": paper.year,
                        "abstract": paper.abstract,
                        "venue": paper.venue,
                        "source": paper.source,
                    }
                )

    merged = dedupe_records(collected)
    papers = [papers_by_key[row["paper_id"]] for row in merged if row["paper_id"] in papers_by_key]
    return SearchOutcome(
        papers=papers,
        per_query=per_query,
        per_source={name: len(ids) for name, ids in paper_ids_by_source.items()},
        failures=failures,
    )


def store_papers(conn: sqlite3.Connection, papers: list[Paper]) -> int:
    for paper in papers:
        repo.ingest_paper(conn, paper)
    return len(papers)


# --------------------------------------------------------------- relevance


def _fts_phrase(text: str) -> str:
    """Quote a phrase for an FTS5 MATCH expression.

    FTS5 escapes a double quote inside a string by doubling it. Topic text comes
    from the submission's own keyword line, so it is not ours to trust: an
    unbalanced quote makes the whole expression invalid, and a crafted one can
    widen the match to every stored paper — which would let a submitting author
    steer which reviewers surface.
    """
    return '"' + text.replace('"', '""') + '"'


def _match_expression(topics: list[str]) -> str:
    """Build the FTS5 MATCH expression for a set of topics.

    Phrases alone are too strict. A submission's own keywords are frequently
    coined — "temporal-order migration" exists in exactly one paper — and
    matching only phrases scored 46 of 476 stored papers on a live run, leaving
    the ranking to decide between a handful of arbitrary survivors. Matching the
    constituent words as well restores recall without costing precision: BM25
    still ranks a paper carrying the whole phrase above one carrying a word of
    it.

    Tokenisation is shared with the scoring side, so retrieval and ranking agree
    on what a topic's words are.
    """
    parts: list[str] = []
    seen: set[str] = set()
    for topic in topics:
        words = tokenize(topic.replace("-", " "))
        if not words:
            # An all-stopword topic would contribute a phrase that matches
            # nothing while making the expression look like it covers something.
            continue
        phrase = " ".join(words)
        if phrase not in seen:
            seen.add(phrase)
            parts.append(_fts_phrase(phrase))
        for word in words:
            if word not in seen:
                seen.add(word)
                parts.append(_fts_phrase(word))
    return " OR ".join(parts)


def _bm25_scores(conn: sqlite3.Connection, profile: Profile, limit: int) -> dict[str, float]:
    """Rank stored papers against the profile using FTS5.

    ``bm25()`` returns lower values for better matches, so the scores are
    inverted and normalised into 0..1 for blending with the other components.
    """
    terms = _match_expression(profile.primary_topics)
    if not terms:
        return {}
    try:
        rows = repo.search_papers(conn, terms, limit=limit)
    except sqlite3.OperationalError as error:
        # An empty pool reads to an editor as "no reviewers exist". Say what
        # actually happened instead.
        log.warn(f"the topic search expression was rejected by FTS5: {error}")
        return {}
    if not rows:
        return {}
    raw = {row["paper_id"]: -float(row["bm25_score"]) for row in rows}
    lo, hi = min(raw.values()), max(raw.values())
    span = hi - lo
    if span <= 0:
        return dict.fromkeys(raw, 1.0)
    return {pid: (value - lo) / span for pid, value in raw.items()}


def _paper_terms(conn: sqlite3.Connection, paper_id: str) -> list[str]:
    return [
        row["term"]
        for row in conn.execute("SELECT term FROM paper_terms WHERE paper_id = ?", (paper_id,))
    ]


def relevance(
    conn: sqlite3.Connection,
    profile: Profile,
    *,
    now_year: int,
    limit: int = 300,
    embeddings: dict[str, float] | None = None,
) -> dict[str, float]:
    """Blend BM25, controlled-term overlap and recency into one score per paper."""
    bm25 = _bm25_scores(conn, profile, limit)
    if not bm25:
        return {}

    weights = dict(RELEVANCE_WEIGHTS)
    if not embeddings:
        # Renormalise so a missing embedding backend does not depress every score.
        weights.pop("embedding")
        total = sum(weights.values())
        weights = {k: v / total for k, v in weights.items()}

    profile_terms = [*profile.primary_topics, *profile.methods]
    scores: dict[str, float] = {}
    for paper_id, bm in bm25.items():
        row = repo.get_paper(conn, paper_id)
        if row is None:
            continue
        components = {
            "bm25": bm,
            "terms": term_overlap(_paper_terms(conn, paper_id), profile_terms),
            "recency": recency_score(row["year"], now_year),
        }
        if embeddings:
            components["embedding"] = embeddings.get(paper_id, 0.0)
        scores[paper_id] = sum(components[k] * weights[k] for k in weights)
    return scores


# -------------------------------------------------------------- candidates


def _readable_url(row) -> str:
    """Where a paper can be opened, preferring what a human can actually read.

    The OpenAlex work id is an API record, not a paper, so it is never used
    here. An open-access landing page is best; a DOI resolves to whatever the
    publisher offers. Nothing is constructed when neither exists.
    """
    # `in` on a sqlite3.Row tests its *values*, not its columns, so the
    # .keys() call is load-bearing however much SIM118 dislikes it.
    columns = row.keys()
    landing = (row["landing_page_url"] or "").strip() if "landing_page_url" in columns else ""
    if landing:
        return landing
    doi = (row["doi"] or "").strip()
    return f"https://doi.org/{doi}" if doi else ""


def build_candidates(
    conn: sqlite3.Connection,
    paper_scores: dict[str, float],
    *,
    top_papers: int = 50,
    min_evidence: int = 1,
) -> list[Candidate]:
    """Collect the authors of the most relevant papers.

    Every author counts, weighted by position. Restricting the search to first and
    second authors would systematically miss senior reviewers in fields that put
    the group leader last.
    """
    ranked = sorted(paper_scores.items(), key=lambda kv: -kv[1])[:top_papers]
    by_person: dict[str, list[Evidence]] = {}

    for paper_id, similarity in ranked:
        row = repo.get_paper(conn, paper_id)
        if row is None:
            continue
        for authorship in conn.execute(
            "SELECT person_id, position, position_weight FROM authorships WHERE paper_id = ?",
            (paper_id,),
        ):
            by_person.setdefault(authorship["person_id"], []).append(
                Evidence(
                    paper_id=paper_id,
                    title=row["title"],
                    year=row["year"],
                    url=_readable_url(row),
                    doi=row["doi"] or "",
                    venue=row["venue"] or "",
                    venue_type=row["venue_type"] or "",
                    position=authorship["position"] or "middle",
                    position_weight=authorship["position_weight"],
                    similarity=similarity,
                )
            )

    candidates: list[Candidate] = []
    for person_id, evidence in by_person.items():
        if len(evidence) < min_evidence:
            continue
        person = repo.load_person(conn, person_id)
        if person is None:
            continue
        evidence.sort(key=lambda e: -e.similarity)
        candidates.append(Candidate(person=person, evidence=evidence[:10]))

    # Ordered by evidence strength, because every downstream `--limit` slices
    # this list. Unordered, enriching 40 of 200 candidates could miss all of the
    # strongest ones.
    candidates.sort(key=lambda c: -sum(e.similarity * e.position_weight for e in c.evidence))
    return candidates


def topics_for(conn: sqlite3.Connection, candidate: Candidate, limit: int = 10) -> list[str]:
    """Infer a candidate's research topics from the papers we hold for them."""
    counts: dict[str, int] = {}
    for row in repo.papers_of(conn, candidate.person.person_id, limit=50):
        for term in _paper_terms(conn, row["paper_id"]):
            counts[term] = counts.get(term, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [term for term, _ in ranked[:limit]]
