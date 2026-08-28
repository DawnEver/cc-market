"""Abstract screening — packet creation, agent-screening import, and keyword filtering.

Two-stage abstract screening: rule-based prefilter, then agent judgement.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from academia.litreview.models import Candidate, ScreeningDecision

_META = ("title", "publication_year", "publication_title", "doi", "html_url", "pdf_url")
_LISTS = ("inclusion_reasons", "exclusion_reasons", "uncertainties")
_DECISIONS = {"include", "maybe", "exclude"}
_PRIORITIES = {"none", "low", "medium", "high"}
_SKIP = {"local_pdf_path", "pdf_path", "pdf_sha256", "full_text", "pdf_text"}


def _load(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".jsonl":
        return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text("utf-8"))
        return data.get("items", data) if isinstance(data, dict) else data
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Screening packet
# ---------------------------------------------------------------------------

def write_screening_packet(candidates_path: Path, out_dir: Path) -> int:
    """Create an abstract-only screening packet (JSONL + CSV)."""
    rows = [{k: v for k, v in r.items() if k not in _SKIP} for r in _load(candidates_path)]
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "screening_packet.jsonl").open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    fields = sorted({k for row in rows for k in row})
    with (out_dir / "screening_packet.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()})
    return len(rows)


# ---------------------------------------------------------------------------
# Agent screening import
# ---------------------------------------------------------------------------

def _index(path: Path) -> tuple[list[str], dict[str, dict[str, Any]]]:
    rows = _read_jsonl(path)
    order, idx = [], {}
    for r in rows:
        cid = str(r.get("candidate_id", "")).strip()
        if not cid:
            raise ValueError("candidate_id is required")
        if cid in idx:
            raise ValueError(f"duplicate candidate id: {cid}")
        order.append(cid)
        idx[cid] = r
    return order, idx


def _validate(row: dict[str, Any], has_abstract: bool) -> dict[str, Any]:
    cid = str(row.get("candidate_id", "")).strip()
    d = str(row.get("decision", "")).strip().lower()
    if d not in _DECISIONS:
        raise ValueError(f"{cid}: decision must be include, maybe, or exclude")
    cf = row.get("confidence")
    if not isinstance(cf, (int, float)) or isinstance(cf, bool) or not 0 <= cf <= 1:
        raise ValueError(f"{cid}: confidence must be 0-1")
    p = str(row.get("download_priority", "")).strip().lower()
    if p not in _PRIORITIES:
        raise ValueError(f"{cid}: download_priority must be none, low, medium, or high")
    lists: dict[str, list[str]] = {}
    for f in _LISTS:
        vals = row.get(f)
        if not isinstance(vals, list) or any(not isinstance(v, str) or not v.strip() for v in vals):
            raise ValueError(f"{cid}: {f} must be an array of non-empty strings")
        lists[f] = [v.strip() for v in vals]
    if not has_abstract:
        if d == "include":
            raise ValueError(f"{cid}: missing abstract cannot be included")
        if not lists["uncertainties"]:
            raise ValueError(f"{cid}: missing abstract requires at least one uncertainty")
    decision = ScreeningDecision(candidate_id=cid, decision=d, confidence=float(cf),
                                 abstract_available=has_abstract, download_priority=p, **lists)
    return {"artifact_version": 1, **decision.to_dict()}


def import_agent_screening(candidates_path: Path, batch_paths: list[Path], out_dir: Path) -> int:
    """Validate and merge agent-authored screening batches."""
    if not batch_paths:
        raise ValueError("at least one batch is required")
    order, candidates = _index(candidates_path)
    decisions: dict[str, dict[str, Any]] = {}
    for bp in batch_paths:
        for row in _read_jsonl(bp):
            cid = str(row.get("candidate_id", "")).strip()
            if not cid:
                raise ValueError(f"{bp}: candidate_id is required")
            if cid in decisions:
                raise ValueError(f"duplicate candidate id: {cid}")
            decisions[cid] = row
    unknown = sorted(set(decisions) - set(candidates))
    if unknown:
        raise ValueError(f"unknown candidate ids: {', '.join(unknown)}")
    missing = sorted(set(candidates) - set(decisions))
    if missing:
        raise ValueError(f"missing screening decisions: {', '.join(missing)}")
    merged: list[dict[str, Any]] = []
    for cid in order:
        c = candidates[cid]
        has_abs = bool(str(c.get("abstract") or "").strip())
        item = _validate(decisions[cid], has_abs)
        for f in _META:
            v = c.get(f)
            item[f] = v if f == "publication_year" and isinstance(v, int) else str(v or "")
        merged.append(item)
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "screening_stage1.jsonl").open("w", encoding="utf-8") as fh:
        for row in merged:
            fh.write(json.dumps(row, ensure_ascii=True) + "\n")
    return len(merged)


# ---------------------------------------------------------------------------
# Keyword filter (from AeroWdg pipeline_filter.py)
# ---------------------------------------------------------------------------

def filter_by_keywords(
    candidates: list[Candidate], keywords: list[str],
    *, mode: str = "any", field: str = "abstract",
) -> list[Candidate]:
    """Filter candidates whose abstract/title contain given keywords.

    Args:
        candidates: Candidate objects to filter.
        keywords: Case-insensitive keywords.
        mode: 'any' (at least one) or 'all' (every keyword).
        field: 'abstract', 'title', or 'both'.
    """
    if not keywords:
        return list(candidates)
    lowered = [kw.lower() for kw in keywords]
    def _matches(c: Candidate) -> bool:
        parts: list[str] = []
        if field in ("abstract", "both"):
            parts.append(c.abstract)
        if field in ("title", "both"):
            parts.append(c.title)
        hs = " ".join(parts).lower()
        return all(kw in hs for kw in lowered) if mode == "all" else any(kw in hs for kw in lowered)
    return [c for c in candidates if _matches(c)]
