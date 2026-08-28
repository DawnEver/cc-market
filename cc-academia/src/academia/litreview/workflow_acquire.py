"""Acquisition phase: screening decisions -> queue -> download -> match -> manifest."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from academia.litreview.state import mark_step

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> Path:
    _ensure(path.parent)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")
    return path


# ---------------------------------------------------------------------------
# 1. Search pipeline
# ---------------------------------------------------------------------------

# 2. Acquire pipeline
# ---------------------------------------------------------------------------

def run_acquire(
    topic_dir: Path,
    *,
    profile: str | None = None,
    browser_channel: str = "chrome",
    queue_only: bool = False,
    candidate_ids: list[str] | None = None,
    approved_by: str = "user",
    limit: int | None = None,
    resolve_oa: bool = True,
    http_only: bool = False,
    rebuild_queue: bool = False,
) -> dict[str, Any]:
    """Run end-to-end acquisition: screening → queue → download → match → manifest.

    Args:
        topic_dir: Path to workspaces/<slug>/
        profile: Browser profile path for authenticated download
        queue_only: If True, only build the queue (for user review)
        candidate_ids: Specific candidate IDs to approve (if None, prompt)
        approved_by: Identity for approval stamp

    Returns:
        Dict with keys: queue_path, downloaded, failed, manifest_path
    """
    from academia.litreview.acquire_pipeline import (
        approve_download_queue,
        manifest_rows,
        match_manual_drop,
        write_download_manifest,
        write_download_queue,
    )

    mark_step(topic_dir, "acquire", "in_progress")

    screening_path = topic_dir / "screening" / "screening_stage1.jsonl"
    download_dir = _ensure(topic_dir / "download")
    handoff_dir = _ensure(topic_dir / "handoff")

    if not screening_path.exists():
        raise FileNotFoundError(f"{screening_path} not found. Run search & screen step first.")

    result: dict[str, Any] = {
        "queue_path": str(download_dir / "download_queue.json"),
        "downloaded": 0,
        "failed": 0,
        "manifest_path": None,
    }

    # --- Build queue ---
    queue_path = download_dir / "download_queue.json"
    should_rebuild = rebuild_queue or not queue_path.exists()

    if not should_rebuild and queue_path.exists():
        existing = json.loads(queue_path.read_text(encoding="utf-8"))
        screening_conf = existing.get("screening_confirmation", {})
        screening_sha = screening_conf.get("screening_sha256")
        if screening_sha:
            current_sha = hashlib.sha256(screening_path.read_bytes()).hexdigest()
            if screening_sha != current_sha:
                print("Screening changed — rebuilding queue.")
                should_rebuild = True
        else:
            # Queue predates screening_sha — cannot verify consistency
            print("Queue has no screening checksum — rebuilding to be safe.")
            should_rebuild = True

    if should_rebuild:
        print("=== Build Download Queue ===")
        write_download_queue(screening_path, download_dir)
    else:
        existing = json.loads(queue_path.read_text(encoding="utf-8"))
        print(f"Queue up to date ({len(existing.get('items', []))} items, use --rebuild-queue to force).")

    if queue_only:
        mark_step(topic_dir, "acquire", "queued", queue_path=result["queue_path"])
        return result

    # --- Approve ---
    queue_path = download_dir / "download_queue.json"
    if candidate_ids:
        approve_download_queue(queue_path, candidate_ids, approved_by)
    else:
        # Auto-approve all 'include' decisions
        queue_data = json.loads(queue_path.read_text(encoding="utf-8"))
        include_ids = [
            str(item["candidate_id"])
            for item in queue_data.get("items", [])
            if item.get("decision") == "include"
        ]
        if include_ids:
            approve_download_queue(queue_path, include_ids, approved_by)

    # --- Download ---
    print("=== Download PDFs ===")
    try:
        from academia.litreview.acquire.engine import HARD_LIMIT, acquire_pdfs
        rows = acquire_pdfs(
            queue_path, topic_dir,
            limit=limit if limit is not None else HARD_LIMIT,
            profile=Path(profile) if profile else None,
            browser_channel=browser_channel,
            resolve_oa=resolve_oa,
            http_only=http_only,
        )
        result["downloaded"] = len(rows)
    except Exception as exc:
        print(f"Download error: {exc}")
        result["failed"] = 1
        mark_step(topic_dir, "acquire", "failed", error=str(exc))
        return result

    # --- Collect ---
    # The ledger already knows which file belongs to which paper; only PDFs a
    # human dropped in manual_drop/ have to be matched by name.
    print("=== Collect PDFs ===")
    from academia.litreview.acquire.ledger import ledger_path

    rows = manifest_rows(ledger_path(topic_dir), queue_path)
    known = {row["candidate_id"] for row in rows}
    rows.extend(
        row for row in match_manual_drop(queue_path, topic_dir)
        if row["candidate_id"] not in known
    )
    result["matched"] = len(rows)

    # --- Manifest ---
    print("=== Create Manifest ===")
    if rows:
        write_download_manifest(rows, handoff_dir, write_md=True)
        result["manifest_path"] = str(handoff_dir / "download_manifest.json")

    mark_step(topic_dir, "acquire", "done",
              downloaded=result["downloaded"],
              matched=result["matched"],
              manifest_path=result["manifest_path"])

    return result


# ---------------------------------------------------------------------------
# 3. Ingest pipeline
# ---------------------------------------------------------------------------

