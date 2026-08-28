"""Ingest phase: manifest -> cache check -> decompose the selected PDFs."""

from __future__ import annotations

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

# 3. Ingest pipeline
# ---------------------------------------------------------------------------

def run_ingest(
    topic_dir: Path,
    *,
    paper_ids: list[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Run on-demand ingestion with cache check.

    Args:
        topic_dir: Path to workspaces/<slug>/
        paper_ids: Specific candidate IDs to decompose. None = all pending.
        dry_run: If True, only report what would be done.

    Returns:
        Dict with keys: succeeded, failed, skipped, pending
    """
    from academia.litreview import ingest_pipeline as ingest_mod

    mark_step(topic_dir, "ingest", "in_progress")

    manifest_path = topic_dir / "handoff" / "download_manifest.json"
    _ensure(topic_dir / "ingest")

    if not manifest_path.exists():
        raise FileNotFoundError(f"{manifest_path} not found. Run acquire step first.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    papers = manifest.get("papers", [])

    # Check cache (canonical slugged output dir, same as decompose_pdfs writes)
    cached, not_requested, pending = [], [], []
    for paper in papers:
        cid = str(paper["candidate_id"])
        output_dir = ingest_mod.ingest_output_dir(topic_dir, cid)
        if output_dir.exists() and (output_dir / "1-paper-text" / "paper.md").exists():
            cached.append(cid)
        elif paper_ids is None or cid in paper_ids:
            pending.append(cid)
        else:
            not_requested.append(cid)

    result = {
        "succeeded": 0,
        "failed": 0,
        "skipped": len(cached) + len(not_requested),
        "cached": len(cached),
        "not_requested": len(not_requested),
        "pending": len(pending),
        "pending_ids": pending,
        "cached_ids": cached,
    }

    if dry_run:
        mark_step(topic_dir, "ingest", "pending", **result)
        return result

    if not pending:
        print(f"Nothing to decompose ({len(cached)} cached, {len(not_requested)} not requested).")
        mark_step(topic_dir, "ingest", "done", **result)
        return result

    # Decompose only the pending papers
    print(f"Decomposing {len(pending)} papers ({len(cached)} cached, {len(not_requested)} not requested)...")
    artifact = ingest_mod.decompose_pdfs(
        manifest_path, topic_dir, confirmed_by_user=True, candidate_ids=pending,
    )

    # Re-count after decomposition
    final_succeeded = sum(1 for i in artifact.get("ingests", []) if i["status"] == "succeeded")
    final_failed = sum(1 for i in artifact.get("ingests", []) if i["status"] == "failed")
    final_skipped = sum(1 for i in artifact.get("ingests", []) if i["status"] == "skipped")

    result.update({
        "succeeded": final_succeeded,
        "failed": final_failed,
        "skipped": final_skipped + len(cached) + len(not_requested),
    })

    mark_step(topic_dir, "ingest", "done", **result)
    return result


# ---------------------------------------------------------------------------
# 4. Deep read (wires orphaned review_paper)
# ---------------------------------------------------------------------------

