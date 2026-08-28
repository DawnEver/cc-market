"""Workspace repair — scan actual files on disk and rebuild state files.

This is the single entry point for recovering from state drift. It never
deletes data
it only adds missing ledger entries and regenerates derived
files (queue CSV, manifest) from the authoritative sources (screening
JSONL, ledger JSONL, PDFs on disk).
"""

from __future__ import annotations

import contextlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from academia.litreview.acquire.types import Attempt, DownloadRecord, Outcome
from academia.litreview.acquire.verify import safe_filename, sha256_file, validate_pdf


def _safe_component(value: str, fallback: str = "paper") -> str:
    """Slugify a value for use as a directory name (same logic as ingest.py)."""
    component = re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")
    return component[:80] or fallback


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Ledger repair: scan PDFs on disk
# ---------------------------------------------------------------------------


def _ingest_slug_variants(candidate_id: str) -> list[str]:
    """Generate possible directory-name slugs for a candidate_id."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(candidate_id).lower()).strip("-")[:80]
    variants = [slug]
    # Also try S2-style IDs with just the hash part
    if candidate_id.startswith("S2-"):
        variants.append(candidate_id.lower()[:80])
    return variants


def _find_ingest_dir_for_cid(
    ingest_root: Path, candidate_id: str
) -> Path | None:
    """Find an ingest directory matching *candidate_id*, regardless of naming convention."""
    if not ingest_root.exists():
        return None
    variants = _ingest_slug_variants(candidate_id)
    for d in ingest_root.iterdir():
        if not d.is_dir():
            continue
        if d.name in variants:
            return d
    # Slow path: look for the candidate_id in each directory's paper.md
    for d in sorted(ingest_root.iterdir()):
        if not d.is_dir():
            continue
        paper_md = d / "1-paper-text" / "paper.md"
        if not paper_md.exists():
            continue
        try:
            content = paper_md.read_text(encoding="utf-8")[:8192].lower()
            if candidate_id.lower() in content:
                return d
        except (OSError, UnicodeDecodeError):
            continue
    return None


def _find_queue_item_for_pdf(
    pdf_stem: str, queue_items: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Match a PDF filename stem to a queue item by candidate_id or title."""
    # Try exact candidate_id match in stem
    for item in queue_items:
        cid = str(item.get("candidate_id") or "")
        cid_slug = safe_filename(cid, 40)
        if cid_slug.lower() in pdf_stem.lower():
            return item
    # Try title substring match
    for item in queue_items:
        title = str(item.get("title") or "")
        title_slug = safe_filename(title, 40)
        if title_slug.lower() in pdf_stem.lower():
            return item
    return None


def repair_ledger(
    pdf_dir: Path,
    ledger_path: Path,
    queue_items: list[dict[str, Any]],
) -> dict[str, int]:
    """Scan *pdf_dir* for PDFs and add missing entries to the ledger.

    Returns counts: {added, already_known, invalid}.
    """
    from academia.litreview.acquire import ledger as ledger_mod

    pdf_dir = Path(pdf_dir)
    existing = ledger_mod.verified_downloads(ledger_path)
    added = 0
    invalid = 0

    for pdf_path in sorted(pdf_dir.glob("*.pdf")):
        try:
            validate_pdf(pdf_path)
        except (OSError, ValueError):
            invalid += 1
            continue

        file_sha = sha256_file(pdf_path)

        # Check if already in ledger (by SHA or path)
        already_known = False
        for _cid, record in existing.items():
            if record.sha256 == file_sha:
                already_known = True
                break
            if record.pdf_path and Path(record.pdf_path).resolve() == pdf_path.resolve():
                already_known = True
                break
        if already_known:
            continue

        # Try to match to a queue item
        matched = _find_queue_item_for_pdf(pdf_path.stem, queue_items)
        cid = str(matched.get("candidate_id") or "") if matched else pdf_path.stem[:40]
        title = (
            str(matched.get("title") or "")
            if matched
            else pdf_path.stem[:80]
        )

        record = DownloadRecord(
            candidate_id=cid,
            title=title,
            outcome=Outcome.DOWNLOADED,
            timestamp=_now(),
            pdf_path=str(pdf_path.resolve()),
            sha256=file_sha,
            source_url="recovered by repair",
            attempts=[Attempt("recovered by repair", "manual", Outcome.DOWNLOADED)],
        )
        ledger_mod.append(ledger_path, record)
        added += 1

    ledger_mod.write_csv_mirror(ledger_path)
    return {"added": added, "already_known": len(existing), "invalid": invalid}


# ---------------------------------------------------------------------------
# Full workspace repair
# ---------------------------------------------------------------------------


def repair_workspace(topic_dir: Path, dry_run: bool = False) -> dict[str, Any]:
    """One-shot repair of all pipeline state for a workspace.

    Scans actual files on disk, cross-references with screening data,
    and regenerates the ledger, queue CSV, and manifest. With *dry_run*
    only reports what would change without modifying anything.
    """
    topic_dir = topic_dir.expanduser().resolve()
    screening_path = topic_dir / "screening" / "screening_stage1.jsonl"
    pdf_dir = topic_dir / "download" / "pdfs"
    ingest_root = topic_dir / "ingest"
    ledger_path = topic_dir / "download" / "ledger.jsonl"
    queue_json = topic_dir / "download" / "download_queue.json"
    topic_dir / "handoff" / "download_manifest.json"

    result: dict[str, Any] = {
        "workspace": str(topic_dir),
        "screening_exists": screening_path.exists(),
        "pdfs_found": 0,
        "ledger_entries": 0,
        "ingest_dirs_found": 0,
        "queue_items": 0,
        "manifest_papers": 0,
        "actions": [],
    }

    # --- Load screening ---
    screening_rows: list[dict[str, Any]] = []
    if screening_path.exists():
        for line in screening_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            with contextlib.suppress(json.JSONDecodeError):
                screening_rows.append(json.loads(line))
    result["screening_rows"] = len(screening_rows)

    # --- Load queue items for matching ---
    queue_items: list[dict[str, Any]] = []
    if queue_json.exists():
        artifact = json.loads(queue_json.read_text(encoding="utf-8"))
        queue_items = list(artifact.get("items", []))
        result["queue_items"] = len(queue_items)

    # --- Repair ledger from PDFs on disk ---
    if pdf_dir.exists():
        result["pdfs_found"] = len(list(pdf_dir.glob("*.pdf")))
        if not dry_run:
            ledger_counts = repair_ledger(pdf_dir, ledger_path, queue_items + screening_rows)
        else:
            # Count what would be added without writing
            from academia.litreview.acquire import ledger as ledger_mod2
            existing = ledger_mod2.verified_downloads(ledger_path)
            ledger_counts = {"added": 0, "already_known": len(existing), "invalid": 0}
            for pdf_path in sorted(pdf_dir.glob("*.pdf")):
                try:
                    validate_pdf(pdf_path)
                except (OSError, ValueError):
                    ledger_counts["invalid"] += 1
                    continue
                file_sha = sha256_file(pdf_path)
                if not any(r.sha256 == file_sha for r in existing.values()):
                    ledger_counts["added"] += 1
        result["ledger_repair"] = ledger_counts
        prefix = "[dry-run] would add" if dry_run else ""
        result["actions"].append(
            f"Ledger: {prefix} {ledger_counts['added']} added, "
            f"{ledger_counts['already_known']} already known, "
            f"{ledger_counts['invalid']} invalid"
        )

    from academia.litreview.acquire import ledger as ledger_mod

    verified = ledger_mod.verified_downloads(ledger_path)
    result["ledger_entries"] = len(verified)

    # --- Scan ingest directories (and link old-style dirs) ---
    if ingest_root.exists():
        ingest_dirs = [
            d for d in ingest_root.iterdir()
            if d.is_dir() and (d / "1-paper-text" / "paper.md").exists()
        ]
        result["ingest_dirs_found"] = len(ingest_dirs)

        # Try to link old title-based dirs to candidate IDs by scanning
        # paper.md content for known IDs. Records the mapping in a sidecar
        # file — never creates incomplete canonical directories that would
        # block future ingestion.
        mapping_path = ingest_root / "compat_map.json"
        compat_map: dict[str, str] = {}
        if mapping_path.exists():
            try:
                compat_map = json.loads(mapping_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                compat_map = {}

        linked = 0
        for d in sorted(ingest_dirs):
            # Skip dirs that already use CID-based naming
            if d.name.startswith(("s2-", "ieee-", "arxiv-", "dblp-")):
                continue
            # Skip already-mapped dirs
            if any(v == d.name for v in compat_map.values()):
                continue
            paper_md = d / "1-paper-text" / "paper.md"
            try:
                content = paper_md.read_text(encoding="utf-8")[:16384]
            except (OSError, UnicodeDecodeError):
                continue
            for row in screening_rows:
                cid = str(row.get("candidate_id") or "")
                if not cid:
                    continue
                if cid.lower() in content.lower():
                    # Record the mapping without creating directories
                    compat_map[_safe_component(cid, "paper")] = d.name
                    linked += 1
                    break

        if linked:
            if not dry_run:
                mapping_path.write_text(
                    json.dumps(compat_map, indent=2, ensure_ascii=True) + "\n",
                    encoding="utf-8",
                )
            prefix = "[dry-run] would save" if dry_run else "saved to"
            result["actions"].append(
                f"Ingest: mapped {linked} old-style directories → candidate IDs "
                f"({prefix} ingest/compat_map.json)"
            )
        result["compat_map"] = compat_map

        result["ingest_dirs"] = [
            {"name": d.name, "has_card": (d / "paper_card.md").exists()}
            for d in sorted(ingest_dirs)
        ]
        result["actions"].append(
            f"Ingest: {len(ingest_dirs)} directories with paper.md, "
            f"{sum(1 for d in ingest_dirs if (d / 'paper_card.md').exists())} with paper cards"
        )

    # --- Rebuild manifest ---
    if queue_json.exists() and verified:
        from academia.litreview.acquire_pipeline import manifest_rows, write_download_manifest

        try:
            rows = manifest_rows(ledger_path, queue_json)
            result["manifest_papers"] = len(rows)
            if not dry_run and rows:
                write_download_manifest(rows, topic_dir / "handoff")
            prefix = "[dry-run] would write" if dry_run else "written"
            result["actions"].append(f"Manifest: {len(rows)} papers {prefix}")
        except Exception as exc:
            result["manifest_error"] = str(exc)
            result["actions"].append(f"Manifest error: {exc}")

    # --- Status table ---
    status_lines = ["", "=== CHP Pipeline Status ===", ""]
    status_lines.append(f"{'Candidate':<50s} {'PDF':<5s} {'Ingest':<7s} {'Card':<5s} {'Decision':<10s}")
    status_lines.append("-" * 80)

    for row in screening_rows:
        cid = str(row.get("candidate_id", ""))
        if not cid:
            continue
        has_pdf = "Y" if cid in verified else "."
        ingest_dir = _find_ingest_dir_for_cid(ingest_root, cid)
        has_ingest = "Y" if ingest_dir else "."
        has_card = "Y" if (ingest_dir and (ingest_dir / "paper_card.md").exists()) else "."
        decision = str(row.get("decision", "?"))[:10]
        status_lines.append(f"{cid[:48]:<50s} {has_pdf:<5s} {has_ingest:<7s} {has_card:<5s} {decision:<10s}")

    # Also list queue-only items not in screening
    for item in queue_items:
        cid = str(item.get("candidate_id", ""))
        if not cid or any(
            str(r.get("candidate_id", "")) == cid for r in screening_rows
        ):
            continue
        has_pdf = "Y" if cid in verified else "."
        ingest_dir = _find_ingest_dir_for_cid(ingest_root, cid)
        has_ingest = "Y" if ingest_dir else "."
        has_card = "Y" if (ingest_dir and (ingest_dir / "paper_card.md").exists()) else "."
        decision = str(item.get("decision", "?"))[:10]
        status_lines.append(f"{cid[:48]:<50s} {has_pdf:<5s} {has_ingest:<7s} {has_card:<5s} {decision:<10s}")

    result["status_table"] = "\n".join(status_lines)

    return result


# ---------------------------------------------------------------------------
# Ingest directory discovery (for Mechanism 4: backward compatibility)
# ---------------------------------------------------------------------------


def find_ingest_output(
    topic_dir: Path, candidate_id: str
) -> Path | None:
    """Find ingest output for *candidate_id* under any naming convention.

    Tries the canonical CID-based slug first (fast path), then falls back
    to scanning all ingest directories for a paper.md that references the
    candidate. Used by ingest_output_dir backward-compat shim.
    """
    from academia.litreview.ingest_pipeline import ingest_output_dir

    canonical = ingest_output_dir(topic_dir, candidate_id)
    if canonical.exists():
        return canonical
    return _find_ingest_dir_for_cid(topic_dir / "ingest", candidate_id)
