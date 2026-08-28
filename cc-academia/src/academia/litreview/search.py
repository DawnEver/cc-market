"""Search orchestration — probe, search, dedupe across providers."""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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


def _query_kwargs(query: dict[str, Any]) -> dict[str, Any]:
    """Extract standard provider kwargs from a query dict."""
    kwargs: dict[str, Any] = {}
    for key in ("year_from", "year_to", "content_types", "sort"):
        if key in query and query[key] is not None:
            kwargs[key] = query[key]
    if "search_scope" in query and query["search_scope"] is not None:
        kwargs["search_scope"] = query["search_scope"]
    return kwargs


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
    fieldnames = ["query_id", "purpose", "status", "total_count", "first_titles", "failure_reason"]
    rows: list[dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
    text_row = {f: str(row.get(f, "")) for f in fieldnames}
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
    for query in enabled:
        qid = str(query.get("query_id", "")).strip()
        raw_expression = _query_expression(query)
        expression = provider.adapt_expression(raw_expression)
        timestamp = datetime.now(UTC).isoformat()
        audit_base = {
            "timestamp": timestamp, "backend": provider.name,
            "query_id": qid, "page_number": 1, "search_expression": raw_expression,
        }

        try:
            result = provider.probe(
                expression, qid, timeout=timeout_seconds, **_query_kwargs(query)
            )
        except Exception as error:
            _append_jsonl(probe_dir / "probe_audit.log", {
                **audit_base, "status": 0, "failure_reason": str(error),
            })
            _append_jsonl(probe_dir / "errors.jsonl", {
                **audit_base, "status": 0, "failure_reason": str(error),
            })
            result_row = {
                "query_id": qid, "purpose": query.get("purpose", ""),
                "status": 0, "total_count": 0, "first_titles": [],
                "failure_reason": str(error),
            }
            _upsert_jsonl(probe_dir / "probe_results.jsonl", result_row)
            _upsert_summary_csv(probe_dir / "probe_summary.csv", {
                **result_row, "first_titles": "",
            })
            exit_code = 1
            if req_delay:
                _time.sleep(req_delay)
            continue

        # Write raw response
        if result.raw_response:
            raw_dir = probe_dir / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / f"{qid}_page_001.json").write_text(
                json.dumps(result.raw_response, indent=2, ensure_ascii=True),
                encoding="utf-8",
            )

        result_row = {
            "query_id": qid,
            "purpose": query.get("purpose", ""),
            "status": "success",
            "total_count": result.total_count,
            "first_titles": result.sample_titles,
            "failure_reason": result.failure_reason,
        }
        _upsert_jsonl(probe_dir / "probe_results.jsonl", result_row)
        _upsert_summary_csv(probe_dir / "probe_summary.csv", {
            **result_row, "first_titles": " | ".join(result.sample_titles),
            "failure_reason": result_row["failure_reason"] or "",
        })
        _append_jsonl(probe_dir / "probe_audit.log", {
            **audit_base, "status": "success", "result_count": result.total_count,
        })
        print(f"{qid}: total={result.total_count}; titles={len(result.sample_titles)}")
        if req_delay:
            _time.sleep(req_delay)

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
    exit_code = 0

    for query in enabled:
        qid = str(query.get("query_id", ""))
        raw_expression = _query_expression(query)
        expression = provider.adapt_expression(raw_expression)

        try:
            results = provider.search_pages(
                expression, qid,
                max_pages=max_pages, per_page=rows_per_page,
                timeout=timeout_seconds,
                **_query_kwargs(query),
            )
        except Exception as error:
            print(f"search error for {qid}: {error}")
            exit_code = 1
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
