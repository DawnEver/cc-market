"""Search orchestration — probe, search, dedupe across providers."""

from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from academia.core.errors import EXIT_SOURCE
from academia.core.http import ACCOUNT_STATUSES, error_status

# Provider factory lives in the providers package; re-exported for callers.
from academia.litreview.candidates import candidate_from_paper
from academia.sources import get_source  # noqa: F401
from academia.sources.base import PaperSource

# ---------------------------------------------------------------------------
# Helpers — unwrap query dicts into provider call args
# ---------------------------------------------------------------------------


def _query_expression(query: dict[str, Any]) -> str:
    expr = str(query.get("expression", "")).strip()
    if not expr:
        raise ValueError(f"query {query.get('query_id', '?')} has no expression")
    return expr


#: Options a plan, brief or workspace may set on a query. ``page``,
#: ``per_page``, ``timeout``, ``query_id`` and ``expression`` are the caller's
#: and are passed explicitly — forwarding one of them from here would be a
#: duplicate-keyword TypeError. ``search_scope`` is not listed because no source
#: has ever accepted it, so it was only ever a way to fail.
QUERY_OPTION_KEYS = ("year_from", "year_to", "content_types", "sort")


def _query_defaults(plan: dict[str, Any], queries_path: Path) -> dict[str, Any]:
    """Options a query inherits when it names none, least specific first.

    Three layers, because they are three different statements and only one of
    them used to be read at all:

    * ``workspace.toml [defaults]`` — this workspace's fallback;
    * the brief's ``[constraints]`` — the scope the researcher approved;
    * ``queries.toml [constraints]`` — inside the query plan's own approval
      hash, so the layer the user actually signed off on. It wins.
    """
    from academia.litreview.brief import brief_constraints
    from academia.litreview.schema import load_data

    def wanted(table: Any) -> dict[str, Any]:
        if not isinstance(table, dict):
            return {}
        return {k: v for k, v in table.items() if k in QUERY_OPTION_KEYS and v is not None}

    defaults: dict[str, Any] = {}

    workspace_path = queries_path.resolve().parent / "workspace.toml"
    if workspace_path.is_file():
        workspace = load_data(workspace_path)
        if isinstance(workspace, dict):
            defaults.update(wanted(workspace.get("defaults")))

    defaults.update(wanted(brief_constraints(queries_path, plan)))
    defaults.update(wanted(plan.get("constraints")))
    return defaults


def _query_kwargs(
    query: dict[str, Any], *, defaults: dict[str, Any], provider: PaperSource
) -> tuple[dict[str, Any], list[str]]:
    """Resolve one query's options against what *provider* actually accepts.

    Returns ``(kwargs, dropped)``. Precedence is *defaults*, then the query's own
    non-null values.

    Anything the provider's signature does not name is dropped **and reported**.
    Silently discarding it is what made every date bound in every brief
    decorative: the filter looked applied, the results looked plausible, and
    nothing anywhere said the two had come apart.
    """
    from academia.sources.base import accepted_search_kwargs

    resolved = dict(defaults)
    for key in QUERY_OPTION_KEYS:
        if query.get(key) is not None:
            resolved[key] = query[key]

    accepted = accepted_search_kwargs(provider)
    if accepted is None:
        return resolved, []

    dropped = sorted(key for key in resolved if key not in accepted)
    return {key: value for key, value in resolved.items() if key in accepted}, dropped


# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def _upsert_jsonl(path: Path, row: dict[str, Any], key: str = "query_id") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
    replaced = False
    for i, existing in enumerate(rows):
        if existing.get(key) == row.get(key):
            rows[i] = row
            replaced = True
            break
    if not replaced:
        rows.append(row)
    with path.open("w", encoding="utf-8") as handle:
        for item in rows:
            handle.write(json.dumps(item, ensure_ascii=True) + "\n")


def _upsert_summary_csv(path: Path, row: dict[str, Any]) -> None:
    # `http_status` is listed so a failed row carries the machine-readable cause
    # next to the human one; the writer drops any key missing from this list.
    fieldnames = [
        "query_id",
        "purpose",
        "status",
        "total_count",
        "first_titles",
        "failure_reason",
        "http_status",
    ]
    rows: list[dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
    text_row = {f: "" if row.get(f) is None else str(row[f]) for f in fieldnames}
    replaced = False
    for i, existing in enumerate(rows):
        if existing.get("query_id") == text_row["query_id"]:
            rows[i] = text_row
            replaced = True
            break
    if not replaced:
        rows.append(text_row)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def failure_reasons(path: Path) -> list[str]:
    """Every distinct ``failure_reason`` recorded in a probe or audit artifact.

    Read back from the file rather than returned by the run: the reason has to
    outlive the process that found it, and the artifact is the only thing that
    does. The old code kept it in an exception object and then discarded it in
    favour of "one or more queries failed", which is why a spent quota reached
    the operator as no information at all.

    Returns an empty list for a missing file, so a caller can treat "nothing
    recorded" and "no such artifact" the same way.
    """
    if not path.exists():
        return []
    reasons: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        reason = row.get("failure_reason") if isinstance(row, dict) else None
        if reason and str(reason) not in reasons:
            reasons.append(str(reason))
    return reasons


def run_probe(
    queries_path: Path,
    out_dir: Path,
    provider: PaperSource,
    query_id: str | None = None,
    allow_unapproved_plan: bool = False,
    timeout_seconds: int = 30,
) -> int:
    """Probe each enabled query via *provider* and write results to *out_dir*."""
    from academia.litreview.query import require_approved_plan
    from academia.litreview.schema import load_data

    plan = load_data(queries_path)
    if not isinstance(plan, dict):
        raise ValueError(f"{queries_path} must contain a YAML object")

    if not allow_unapproved_plan:
        require_approved_plan(plan, queries_path=queries_path)

    query_list = plan.get("queries", [])
    if not isinstance(query_list, list) or not query_list:
        raise ValueError("queries.toml does not contain any queries")

    enabled = [q for q in query_list if isinstance(q, dict) and q.get("enabled") is True]
    if query_id:
        enabled = [q for q in enabled if q.get("query_id") == query_id]
        if not enabled:
            raise ValueError(f"enabled query id not found: {query_id}")
    if not enabled:
        raise ValueError("queries.toml does not contain any enabled queries")

    # Namespace per provider so multi-provider runs never overwrite each other.
    probe_dir = out_dir / "probe" / provider.name
    probe_dir.mkdir(parents=True, exist_ok=True)

    import time as _time

    exit_code = 0
    req_delay = getattr(provider, "request_delay", None)
    abort_reason: str | None = None
    abort_status: int | None = None
    #: Dropped-option sets already announced, so a provider that cannot filter
    #: by content type says so once instead of once per query.
    warned: set[tuple[str, ...]] = set()
    defaults = _query_defaults(plan, queries_path)

    def record(row: dict[str, Any], audit: dict[str, Any]) -> None:
        """Write one query's verdict to all three artifacts at once.

        Together or not at all: the bug this replaces was a set of artifacts
        that disagreed with each other, and a reader who trusted the wrong one
        concluded the literature was empty.
        """
        _upsert_jsonl(probe_dir / "probe_results.jsonl", row)
        _upsert_summary_csv(
            probe_dir / "probe_summary.csv",
            {**row, "first_titles": " | ".join(row.get("first_titles") or [])},
        )
        _append_jsonl(probe_dir / "probe_audit.log", audit)

    for query in enabled:
        qid = str(query.get("query_id", "")).strip()
        raw_expression = _query_expression(query)
        expression = provider.adapt_expression(raw_expression)
        kwargs, dropped = _query_kwargs(query, defaults=defaults, provider=provider)
        audit_base = {
            "timestamp": datetime.now(UTC).isoformat(), "backend": provider.name,
            "query_id": qid, "page_number": 1, "search_expression": raw_expression,
            "dropped_kwargs": dropped,
        }
        purpose = query.get("purpose", "")

        # The account has nothing left to give, so every remaining query has the
        # same answer. Recording that once and stopping beats probing on: a run
        # that halts leaves a reason a reader can act on, where one that
        # continues leaves fifty rows each looking like an empty literature.
        if abort_reason is not None:
            record(
                {
                    "query_id": qid, "purpose": purpose, "status": "not_probed",
                    "total_count": 0, "first_titles": [],
                    "failure_reason": abort_reason, "http_status": abort_status,
                },
                {
                    **audit_base, "status": "not_probed", "result_count": 0,
                    "failure_reason": abort_reason, "http_status": abort_status,
                },
            )
            continue

        if dropped and tuple(dropped) not in warned:
            warned.add(tuple(dropped))
            print(
                f"  {provider.name}: does not accept {', '.join(dropped)}; "
                f"not applied to any query"
            )

        try:
            result = provider.probe(
                expression, qid, timeout=timeout_seconds, **kwargs
            )
        except Exception as error:
            reason = str(error)
            _append_jsonl(probe_dir / "errors.jsonl", {
                **audit_base, "status": "failed", "failure_reason": reason,
            })
            record(
                {
                    "query_id": qid, "purpose": purpose, "status": "failed",
                    "total_count": 0, "first_titles": [],
                    "failure_reason": reason, "http_status": None,
                },
                {
                    **audit_base, "status": "failed", "result_count": 0,
                    "failure_reason": reason, "http_status": None,
                },
            )
            exit_code = exit_code or 1
            if req_delay:
                _time.sleep(req_delay)
            continue

        # Write raw response
        if result.raw:
            raw_dir = probe_dir / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / f"{qid}_page_001.json").write_text(
                json.dumps(result.raw, indent=2, ensure_ascii=True),
                encoding="utf-8",
            )

        # The verdict comes from the probe, never from the fact that we got this
        # far. A probe reports a dead source as a value rather than an
        # exception, so "no exception raised" is not the same as "the source
        # answered" — conflating the two is what let an exhausted quota be
        # written down as a query that matched nothing.
        failed = result.failure_reason is not None
        status = "failed" if failed else "success"
        record(
            {
                "query_id": qid, "purpose": purpose, "status": status,
                "total_count": result.total_count,
                "first_titles": result.sample_titles,
                "failure_reason": result.failure_reason,
                "http_status": result.failure_status,
            },
            {
                **audit_base, "status": status, "result_count": result.total_count,
                "failure_reason": result.failure_reason,
                "http_status": result.failure_status,
            },
        )

        if failed:
            _append_jsonl(probe_dir / "errors.jsonl", {
                **audit_base, "status": status,
                "failure_reason": result.failure_reason,
                "http_status": result.failure_status,
            })
            print(f"{qid}: FAILED — {result.failure_reason}")
            if result.is_account_failure:
                abort_reason, abort_status = result.failure_reason, result.failure_status
                exit_code = EXIT_SOURCE
            else:
                exit_code = exit_code or 1
        else:
            print(f"{qid}: total={result.total_count}; titles={len(result.sample_titles)}")

        if req_delay:
            _time.sleep(req_delay)

    if abort_reason is not None:
        print(
            f"probe aborted after {abort_reason}: the provider is refusing every "
            f"query, so the remaining ones were not attempted.",
            file=sys.stderr,
        )

    return exit_code


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


def run_search(
    queries_path: Path,
    out_dir: Path,
    provider: PaperSource,
    max_pages: int = 5,
    rows_per_page: int = 25,
    delay_seconds: float = 1.0,
    query_id: str | None = None,
    allow_unapproved_plan: bool = False,
    evaluation_path: Path | None = None,
    timeout_seconds: int = 30,
) -> tuple[int, list[dict[str, Any]]]:
    """Run bounded full metadata searches for eligible queries.

    Returns (exit_code, normalized_records). All on-disk artifacts are
    namespaced per provider so multi-provider runs cannot collide.
    """
    from academia.litreview.query import query_plan_sha256, require_approved_plan
    from academia.litreview.schema import load_data

    plan = load_data(queries_path)
    if not isinstance(plan, dict):
        raise ValueError(f"{queries_path} must contain a YAML object")

    if not allow_unapproved_plan:
        require_approved_plan(plan, queries_path=queries_path)

    if not (1 <= max_pages <= 100 and 1 <= rows_per_page <= 100 and delay_seconds >= 0):
        raise ValueError("max_pages/rows_per_page must be 1..100; delay must be non-negative")

    query_list = plan.get("queries", [])
    if not isinstance(query_list, list):
        raise ValueError("queries.toml does not contain any queries")

    enabled = [q for q in query_list if isinstance(q, dict) and q.get("enabled") is True]
    if query_id:
        enabled = [q for q in enabled if q.get("query_id") == query_id]

    # Validate evaluation eligibility
    if not allow_unapproved_plan:
        if evaluation_path is None or not evaluation_path.exists():
            raise ValueError("query evaluation is required before full metadata search")
        eval_artifact = load_data(evaluation_path)
        if not isinstance(eval_artifact, dict) or eval_artifact.get("queries_sha256") != query_plan_sha256(plan):
            raise ValueError("query evaluation belongs to a different query plan; run evaluate-queries again")
        suggestions = eval_artifact.get("suggestions")
        if not isinstance(suggestions, list):
            raise ValueError("query evaluation must contain suggestions")
        by_id = {
            str(item.get("query_id")): item
            for item in suggestions
            if isinstance(item, dict) and item.get("query_id")
        }
        eligible = []
        for q in enabled:
            qid = str(q.get("query_id", ""))
            ev = by_id.get(qid)
            if ev is None:
                raise ValueError(f"query evaluation is missing enabled query: {qid}")
            if ev.get("eligible_for_full_search") is not True:
                raise ValueError(
                    f"query is not eligible for full search: {qid} ({ev.get('classification', 'unknown')})"
                )
            eligible.append(q)
        enabled = eligible

    search_dir = out_dir / "search"
    search_dir.mkdir(parents=True, exist_ok=True)
    prov_name = provider.name

    records_out: list[dict[str, Any]] = []
    audits: list[dict[str, Any]] = []
    warned: set[tuple[str, ...]] = set()
    defaults = _query_defaults(plan, queries_path)
    exit_code = 0

    for query in enabled:
        qid = str(query.get("query_id", ""))
        raw_expression = _query_expression(query)
        expression = provider.adapt_expression(raw_expression)

        kwargs, dropped = _query_kwargs(query, defaults=defaults, provider=provider)
        if dropped and tuple(dropped) not in warned:
            warned.add(tuple(dropped))
            print(
                f"  {provider.name}: does not accept {', '.join(dropped)}; "
                f"not applied to any query"
            )

        try:
            results = provider.search_pages(
                expression, qid,
                max_pages=max_pages, per_page=rows_per_page,
                timeout=timeout_seconds,
                **kwargs,
            )
        except Exception as error:
            print(f"search error for {qid}: {error}")
            # A failed query gets an audit row like any other. Leaving it out
            # meant the file the error message points at ("see audit log")
            # recorded no failure at all — and when every query failed, the
            # audit log was written empty, which reads as a clean run.
            reason = getattr(error, "reason", None) or str(error)
            status = error_status(error)
            audits.append({
                "timestamp": datetime.now(UTC).isoformat(), "query_id": qid,
                "search_expression": expression,
                "page_number": 1,
                "rows_per_page": rows_per_page,
                "status": "failed",
                "record_count": 0,
                "total_count": 0,
                "failure_reason": reason,
                "http_status": status,
                "dropped_kwargs": dropped,
            })
            if status in ACCOUNT_STATUSES:
                exit_code = EXIT_SOURCE
                break
            exit_code = exit_code or 1
            continue

        for _page_index, result in enumerate(results, start=1):
            stamp = datetime.now(UTC).isoformat()
            audits.append({
                "timestamp": stamp, "query_id": qid,
                "search_expression": expression,
                "page_number": result.page,
                "rows_per_page": rows_per_page,
                "status": "success",
                "record_count": len(result.papers),
                "total_count": result.total_count,
                "failure_reason": None,
                "http_status": None,
                "dropped_kwargs": dropped,
            })

            # Write raw response (namespaced per provider)
            if result.raw:
                raw_dir = search_dir / "raw" / prov_name
                raw_dir.mkdir(parents=True, exist_ok=True)
                (raw_dir / f"{qid}_page_{result.page:03d}.json").write_text(
                    json.dumps(result.raw, indent=2, ensure_ascii=True),
                    encoding="utf-8",
                )

            # Sources hand back Paper objects; the workspace format is this
            # package's own concern, so the conversion happens here rather than
            # inside every source.
            for position, paper in enumerate(result.papers, start=1):
                rank = (result.page - 1) * rows_per_page + position
                candidate = candidate_from_paper(
                    paper, query_id=qid, rank=rank,
                    page=result.page, search_expression=expression,
                )
                candidate.update({
                    "query_purpose": query.get("purpose", ""),
                    "page_position": position,
                    "result_position": rank,
                })
                records_out.append(candidate)

    # Write output artifacts (namespaced per provider)
    if records_out:
        with (search_dir / f"records_{prov_name}.jsonl").open("w", encoding="utf-8") as handle:
            for row in records_out:
                handle.write(json.dumps(row, ensure_ascii=True) + "\n")

    with (search_dir / f"search_audit_{prov_name}.log").open("w", encoding="utf-8") as handle:
        for audit in audits:
            handle.write(json.dumps(audit, ensure_ascii=True) + "\n")

    fields = [
        "candidate_id", "source_provider", "query_id", "page", "page_position",
        "result_position", "search_expression", "title", "article_number", "doi",
    ]
    with (search_dir / f"records_{prov_name}.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records_out)

    return exit_code, records_out


# ---------------------------------------------------------------------------
# Deduplicate and rank
# ---------------------------------------------------------------------------


def normalize_doi(value: Any) -> str:
    """Normalize a DOI string for comparison."""
    text = str(value or "").strip().lower()
    return re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text).rstrip(" .")


def normalize_title(value: Any) -> str:
    """Normalize a title for fuzzy matching."""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[\w]+", text, flags=re.UNICODE))


def _keys(row: dict[str, Any]) -> list[str]:
    keys = []
    doi = normalize_doi(row.get("doi"))
    article = str(row.get("article_number") or row.get("articleNumber") or "").strip()
    title = normalize_title(row.get("title") or row.get("articleTitle"))
    if doi:
        keys.append("doi:" + doi)
    if article:
        keys.append("article:" + article)
    if title:
        keys.append("title:" + title)
    return keys


def _quality(row: dict[str, Any]) -> tuple[int, int, int, int]:
    return (
        bool(row.get("abstract")),
        int(row.get("citation_count") or 0),
        int(row.get("publication_year") or 0),
        len(str(row.get("title") or "")),
    )


def _stable_row_key(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, ensure_ascii=True, default=str)


def _has_value(value: Any) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def _merge_group(group: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(group, key=lambda r: (_quality(r), _stable_row_key(r)), reverse=True)
    merged = dict(ordered[0])
    for row in ordered[1:]:
        for key, value in row.items():
            if not _has_value(merged.get(key)) and _has_value(value):
                merged[key] = value
    return merged


def run_dedupe_rank(input_paths: list[Path], out_dir: Path) -> int:
    """Deduplicate and rank candidate records from one or more JSONL inputs."""
    rows: list[dict[str, Any]] = []
    for path in input_paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))

    groups: list[list[dict[str, Any]]] = []
    key_group: dict[str, int] = {}
    for row in rows:
        matches = sorted({key_group[k] for k in _keys(row) if k in key_group})
        if not matches:
            index = len(groups)
            groups.append([row])
        else:
            index = matches[0]
            groups[index].append(row)
            for other in reversed(matches[1:]):
                groups[index].extend(groups[other])
                groups[other] = []
        for member in groups[index]:
            for key in _keys(member):
                key_group[key] = index

    merged: list[dict[str, Any]] = []
    for group in (g for g in groups if g):
        item = _merge_group(group)
        item["doi"] = normalize_doi(item.get("doi"))
        item["matched_query_ids"] = sorted({
            str(r.get("query_id")) for r in group if r.get("query_id")
        })
        item["merged_candidate_ids"] = sorted({
            str(r.get("candidate_id")) for r in group if r.get("candidate_id")
        })
        citations = max(int(r.get("citation_count") or 0) for r in group)
        year = max(int(r.get("publication_year") or 0) for r in group)
        item["ranking_score"] = (
            citations
            + len(item["matched_query_ids"]) * 10
            + (year - 1900 if year else 0) / 100
        )
        item["ranking_explanation"] = (
            f"query_matches={len(item['matched_query_ids'])}; "
            f"citation_count={citations}; publication_year={year or 'unknown'}"
        )
        merged.append(item)

    merged.sort(key=lambda r: (-r["ranking_score"], normalize_title(r.get("title"))))
    for rank, row in enumerate(merged, 1):
        row["dedupe_rank"] = rank

    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "candidates_ranked.jsonl").open("w", encoding="utf-8") as handle:
        for row in merged:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")

    report = {
        "input_count": len(rows),
        "unique_count": len(merged),
        "duplicate_count": len(rows) - len(merged),
    }
    (out_dir / "dedupe_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    fields = sorted({key for row in merged for key in row})
    with (out_dir / "candidates_ranked.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in merged:
            writer.writerow({
                k: json.dumps(v) if isinstance(v, list) else v for k, v in row.items()
            })

    return 0
