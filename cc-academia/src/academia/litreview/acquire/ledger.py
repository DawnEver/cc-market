"""The download ledger — append-only record of what acquisition produced.

Previously the downloader named each file `<candidate_id>_<title>.pdf`, threw
away the mapping, and a later stage re-derived it by extracting PDF text and
running an exponential maximum-weight assignment. The information was known at
download time
the ledger simply keeps it.

Downstream stages read this instead of scanning directories, so the
paper -> file mapping is recorded once by the only component that actually
knows it.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from academia.litreview.acquire.types import DownloadRecord, Outcome
from academia.litreview.acquire.verify import sha256_file, validate_pdf

LEDGER_NAME = "ledger.jsonl"


def ledger_path(run_dir: Path) -> Path:
    return run_dir / "download" / LEDGER_NAME


def append(path: Path, record: DownloadRecord) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record.to_dict(), ensure_ascii=True) + "\n")


CSV_FIELDS = ["candidate_id", "status", "pdf_path", "sha256", "source_url", "timestamp", "error"]


def write_csv_mirror(path: Path) -> Path:
    """Rewrite the human-readable CSV as a pure projection of the ledger.

    Derived, never authored: a second hand-maintained log is exactly the kind
    of thing that drifts out of sync with the truth.
    """
    csv_path = path.parent / "download_log.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for record in read(path):
            writer.writerow({
                "candidate_id": record.candidate_id,
                "status": record.outcome.value,
                "pdf_path": record.pdf_path,
                "sha256": record.sha256,
                "source_url": record.source_url,
                "timestamp": record.timestamp,
                "error": record.failure_summary(),
            })
    return csv_path


def read(path: Path) -> list[DownloadRecord]:
    """All records, oldest first. Unparseable lines are skipped, not fatal."""
    if not path.exists():
        return []
    records: list[DownloadRecord] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(DownloadRecord.from_dict(json.loads(line)))
        except (ValueError, TypeError):
            continue
    return records


def latest_by_candidate(path: Path) -> dict[str, DownloadRecord]:
    """Last record per candidate — a later retry supersedes an earlier failure."""
    latest: dict[str, DownloadRecord] = {}
    for record in read(path):
        if record.candidate_id:
            latest[record.candidate_id] = record
    return latest


def verified_downloads(path: Path) -> dict[str, DownloadRecord]:
    """Successful records whose PDF still exists on disk with the same hash.

    Re-checking the file means a deleted or corrupted PDF is re-downloaded
    rather than assumed present.
    """
    verified: dict[str, DownloadRecord] = {}
    for cid, record in latest_by_candidate(path).items():
        if record.outcome is not Outcome.DOWNLOADED or not record.pdf_path:
            continue
        pdf = Path(record.pdf_path)
        try:
            validate_pdf(pdf)
        except (OSError, ValueError):
            continue
        if record.sha256 and sha256_file(pdf).lower() != record.sha256.lower():
            continue
        verified[cid] = record
    return verified
