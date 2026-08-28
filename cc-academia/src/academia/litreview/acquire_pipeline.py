"""Download queue, PDF matching, and pre-ingest manifest operations."""

from __future__ import annotations

import csv
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ARTIFACT_VERSION = 1

INCLUDED_DECISIONS = {"include", "maybe"}
PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2, "none": 3, "": 3}
CSV_FIELDS = [
    "candidate_id", "title", "publication_year", "publication_title",
    "doi", "html_url", "pdf_url", "decision", "confidence",
    "inclusion_reasons", "exclusion_reasons", "uncertainties",
    "abstract_available", "download_priority", "approved",
]


# ---------------------------------------------------------------------------
# Shared PDF utilities
# ---------------------------------------------------------------------------


# Canonical definitions live in acquire.verify; re-exported here so the many
# existing `from pipeline.acquire import validate_pdf` callers keep working.
from academia.litreview.acquire.verify import (  # noqa: E402
    safe_filename,
    sha256_file,
    validate_pdf,
)

__all__ = [
    "approve_download_queue",
    "manifest_rows",
    "match_manual_drop",
    "safe_filename",
    "sha256_file",
    "validate_pdf",
    "write_download_manifest",
    "write_download_queue",
]


# ---------------------------------------------------------------------------
# Download queue
# ---------------------------------------------------------------------------


def _normalize_cell(value: Any) -> str:
    return str(value or "").strip()


def _read_screening(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".jsonl":
        rows: list[dict[str, Any]] = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} must contain a JSON object")
            rows.append(value)
        return rows
    # CSV
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"candidate_id", "decision"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path} missing required columns: {', '.join(sorted(missing))}")
        return [{k: _normalize_cell(v) for k, v in row.items()} for row in reader]


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = _normalize_cell(value)
    if not text:
        return []
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
    return [item.strip() for item in text.split(";") if item.strip()]


def _queue_sort_key(row: dict[str, str]) -> tuple[int, int, str]:
    decision_rank = 0 if row.get("decision", "").lower() == "include" else 1
    priority_rank = PRIORITY_ORDER.get(row.get("download_priority", "").lower(), 3)
    return (priority_rank, decision_rank, row.get("candidate_id", ""))


def _build_queue_items(screening_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in screening_rows:
        cid = row.get("candidate_id", "")
        decision = row.get("decision", "").lower()
        priority = row.get("download_priority", "").lower()
        if not cid or cid in seen:
            continue
        if decision not in INCLUDED_DECISIONS or priority == "none":
            continue
        seen.add(cid)
        item: dict[str, Any] = {
            "candidate_id": cid,
            "title": row.get("title", ""),
            "publication_year": row.get("publication_year", ""),
            "publication_title": row.get("publication_title", ""),
            "doi": row.get("doi", ""),
            "html_url": row.get("html_url", ""),
            "pdf_url": row.get("pdf_url", ""),
            "decision": decision,
            "inclusion_reasons": _string_list(row.get("inclusion_reasons") or row.get("reasons")),
            "exclusion_reasons": _string_list(row.get("exclusion_reasons")),
            "uncertainties": _string_list(row.get("uncertainties")),
            "download_priority": priority or "none",
            "approved": False,
        }
        confidence = row.get("confidence")
        if confidence not in (None, ""):
            item["confidence"] = float(confidence)
        aa = row.get("abstract_available")
        if isinstance(aa, bool):
            item["abstract_available"] = aa
        elif _normalize_cell(aa).lower() in {"true", "false"}:
            item["abstract_available"] = _normalize_cell(aa).lower() == "true"
        items.append(item)
    return sorted(items, key=_queue_sort_key)


def _write_queue_csv(path: Path, items: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for item in items:
            row = {field: item.get(field, "") for field in CSV_FIELDS}
            for field in ("inclusion_reasons", "exclusion_reasons", "uncertainties"):
                row[field] = json.dumps(row[field], ensure_ascii=True)
            if isinstance(row["abstract_available"], bool):
                row["abstract_available"] = str(row["abstract_available"]).lower()
            row["approved"] = "false"
            writer.writerow(row)


def _screening_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_download_queue(
    screening_path: Path, out_dir: Path, confirmed_by_user: bool = False
) -> int:
    """Generate an unapproved download queue from screening output."""
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = _read_screening(screening_path)
    items = _build_queue_items(rows)
    _write_queue_csv(out_dir / "download_queue.csv", items)

    confirmation = {
        "confirmed": bool(confirmed_by_user),
        "confirmed_at": (
            datetime.now().astimezone().isoformat(timespec="seconds")
            if confirmed_by_user else None
        ),
        "confirmed_by": "user" if confirmed_by_user else None,
        "screening_sha256": _screening_digest(screening_path),
    }
    artifact = {
        "artifact_version": ARTIFACT_VERSION,
        "screening_confirmation": confirmation,
        "items": items,
    }
    (out_dir / "download_queue.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    print(f"queued={len(items)}; approved=false")
    return 0


def approve_download_queue(
    queue_path: Path, candidate_ids: list[str], approved_by: str
) -> int:
    """Approve selected queue entries and record the approver identity."""
    if not approved_by.strip():
        raise ValueError("approved_by is required")

    artifact = json.loads(queue_path.read_text(encoding="utf-8"))
    requested = set(candidate_ids)
    known = {str(item.get("candidate_id", "")) for item in artifact.get("items", [])}
    missing = requested - known
    if missing:
        raise ValueError(f"unknown candidate ids: {', '.join(sorted(missing))}")

    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    artifact.setdefault("screening_confirmation", {}).update({
        "confirmed": True, "confirmed_at": timestamp, "confirmed_by": approved_by.strip(),
    })

    count = 0
    for item in artifact.get("items", []):
        if item.get("candidate_id") in requested:
            item["approved"] = True
            item["approval"] = {"approved_by": approved_by.strip(), "approved_at": timestamp}
            count += 1

    queue_path.write_text(
        json.dumps(artifact, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    csv_path = queue_path.with_suffix(".csv")
    if csv_path.exists():
        _write_queue_csv(csv_path, artifact.get("items", []))
        approved_ids = {
            str(i.get("candidate_id"))
            for i in artifact.get("items", [])
            if i.get("approved") is True
        }
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        for row in rows:
            row["approved"] = "true" if row.get("candidate_id") in approved_ids else "false"
        with csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
            writer.writeheader()
            writer.writerows(rows)

    return count


# ---------------------------------------------------------------------------
# PDF matching
# ---------------------------------------------------------------------------


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def manifest_rows(ledger_path: Path, queue_path: Path) -> list[dict[str, Any]]:
    """Join successful ledger records with their queue metadata.

    This replaces PDF-text extraction plus maximum-weight assignment. The
    downloader already recorded which file belongs to which paper
    matching
    only ever existed because that fact was thrown away.
    """
    from academia.litreview.acquire import ledger as ledger_mod

    queue = json.loads(queue_path.read_text(encoding="utf-8")) if queue_path.exists() else {}
    by_id = {
        str(item.get("candidate_id") or ""): item
        for item in queue.get("items", [])
    }

    rows: list[dict[str, Any]] = []
    for cid, record in ledger_mod.verified_downloads(ledger_path).items():
        item = by_id.get(cid, {})
        rows.append({
            "candidate_id": cid,
            "title": record.title or str(item.get("title") or ""),
            "doi": str(item.get("doi") or ""),
            "article_number": str(item.get("article_number") or ""),
            "pdf_path": record.pdf_path,
            "screening_reason": "; ".join(item.get("inclusion_reasons") or []),
            "reading_questions": list(item.get("uncertainties") or []),
        })
    return sorted(rows, key=lambda r: r["candidate_id"])


def match_manual_drop(queue_path: Path, run_dir: Path) -> list[dict[str, Any]]:
    """Attach user-dropped PDFs to queue items by DOI / id / title in the name.

    Only files a human placed in `manual_drop/` need matching at all, and one
    file maps to at most one paper, so a per-file best match is sufficient —
    no assignment problem, no exponential search.
    """
    drop_dir = run_dir / "manual_drop"
    if not drop_dir.exists():
        return []

    artifact = json.loads(queue_path.read_text(encoding="utf-8"))
    items = [i for i in artifact.get("items", []) if i.get("approved") is True]

    rows: list[dict[str, Any]] = []
    claimed: set[str] = set()
    for pdf in sorted(drop_dir.glob("*.pdf")):
        try:
            validate_pdf(pdf)
        except (OSError, ValueError):
            continue
        haystack = pdf.name.lower()
        best, best_score = None, 0
        for item in items:
            cid = str(item.get("candidate_id") or "")
            if cid in claimed:
                continue
            doi = str(item.get("doi") or "").lower()
            title = str(item.get("title") or "").lower()
            score = 0
            if doi and doi.replace("/", "_") in haystack.replace("/", "_"):
                score = 100
            elif cid and re.search(rf"(?:^|[^a-z0-9]){re.escape(cid.lower())}(?:[^a-z0-9]|$)",
                                   haystack):
                # Token boundaries matter: a short id like "a" would otherwise
                # match any filename containing that letter.
                score = 80
            elif len(title) >= 16 and title[:40] in haystack:
                score = 70
            if score > best_score:
                best, best_score = item, score
        if best is None:
            continue
        cid = str(best.get("candidate_id") or "")
        claimed.add(cid)
        rows.append({
            "candidate_id": cid,
            "title": str(best.get("title") or ""),
            "doi": str(best.get("doi") or ""),
            "article_number": str(best.get("article_number") or ""),
            "pdf_path": str(pdf.resolve()),
            "screening_reason": "; ".join(best.get("inclusion_reasons") or []),
            "reading_questions": list(best.get("uncertainties") or []),
        })
    return rows


def _load_matches(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("matches") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        raise ValueError("matches input must be an array or an object with a matches array")
    return rows


def _build_papers(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    papers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        cid = str(row.get("candidate_id") or "").strip()
        title = str(row.get("title") or "").strip()
        raw_path = str(row.get("pdf_path") or "").strip()
        if not cid or not title or not raw_path:
            raise ValueError("each match requires candidate_id, title, and pdf_path")
        if cid in seen:
            raise ValueError(f"duplicate candidate_id: {cid}")
        seen.add(cid)

        pdf_path = Path(raw_path).expanduser().resolve()
        validate_pdf(pdf_path)

        questions = row.get("reading_questions") or []
        if not isinstance(questions, list) or not all(isinstance(q, str) for q in questions):
            raise ValueError(f"reading_questions must be a string array for {cid}")

        papers.append({
            "candidate_id": cid,
            "title": title,
            "doi": str(row.get("doi") or "").strip(),
            "article_number": str(row.get("article_number") or "").strip(),
            "pdf_path": str(pdf_path),
            "sha256": sha256_file(pdf_path),
            "screening_reason": str(row.get("screening_reason") or "").strip(),
            "reading_questions": questions,
        })
    return papers


def write_download_manifest(source: Path | list[dict[str, Any]], out_dir: Path,
                           write_md: bool = False) -> int:
    """Create a validated pre-ingest PDF download manifest.

    Accepts either already-built rows (the ledger path) or a legacy match
    report on disk. By default only writes the JSON manifest
    pass
    *write_md=True* for the human-readable markdown handoff file.
    """
    rows = _load_matches(source) if isinstance(source, Path) else list(source)
    papers = _build_papers(rows)
    generated_at = datetime.now(UTC).isoformat()
    # Stable, content-derived manifest id: the same set of papers always yields
    # the same id, which keeps re-acquisition idempotent.
    manifest_id = hashlib.sha256(
        json.dumps(papers, sort_keys=True, ensure_ascii=True).encode("utf-8")
    ).hexdigest()[:16]
    artifact = {
        "artifact_version": ARTIFACT_VERSION,
        "manifest_type": "download_manifest",
        "manifest_id": manifest_id,
        "run_id": manifest_id,
        "generated_at": generated_at,
        "papers": papers,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "download_manifest.json"
    manifest_path.write_text(
        json.dumps(artifact, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    if write_md:
        lines = [
            "# Download Manifest", "",
            f"Validated PDFs: {len(papers)}",
            f"Machine-readable manifest: `{manifest_path.resolve()}`", "",
        ]
        for paper in papers:
            lines.extend([
                f"## {paper['candidate_id']}: {paper['title']}", "",
                f"- PDF: `{paper['pdf_path']}`",
                f"- SHA-256: `{paper['sha256']}`",
                f"- Screening reason: {paper['screening_reason'] or 'Not recorded'}",
            ])
            if paper["reading_questions"]:
                lines.append("- Reading questions: " + "; ".join(paper["reading_questions"]))
            lines.append("")
        lines.extend([
            "## Handoff Gate", "",
            "Do you want to decompose all validated PDFs with `paper_pdf_ingest` now?",
            "No decomposition or detailed-reading work has been started.", "",
        ])
        (out_dir / "download_manifest.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"validated={len(papers)}; handoff gate reached")
        print("Do you want to decompose all validated PDFs with paper_pdf_ingest now?")

    return len(papers)
