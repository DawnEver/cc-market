"""Acquisition engine — for each paper, for each source, for each transport.

The whole policy lives here and nowhere else:

  * sources are tried in reliability order (repository before publisher),
  * transports are tried in cost order (plain HTTP before a browser),
  * a `Denied` verdict disables that transport for the rest of the run rather
    than being rediscovered once per paper,
  * every attempt is recorded, so a failure says which URL failed and why.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from academia.litreview.acquire import ledger as ledger_mod
from academia.litreview.acquire.transport import Transport, default_transports
from academia.litreview.acquire.types import (
    Attempt,
    DownloadRecord,
    Outcome,
    Source,
    outcome_of,
)
from academia.litreview.acquire.verify import safe_filename, sha256_file, validate_pdf

DEFAULT_LIMIT = 10
HARD_LIMIT = 20


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class _CallableTransport:
    """Adapts an injected `downloader(item, target, url)` into a Transport."""

    name = "injected"
    cost = 0

    def __init__(self, func: Callable[[dict[str, Any], Path, str], str], item: dict[str, Any]):
        self.func = func
        self.item = item

    def can_handle(self, source: Source) -> bool:
        return bool(source.url)

    def fetch(self, source: Source, target: Path) -> str | None:
        return self.func(self.item, target, source.url)


def select_pending(
    items: list[dict[str, Any]],
    limit: int = DEFAULT_LIMIT,
    completed_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """Approved items that still need a PDF, capped at *limit*."""
    if limit < 1:
        raise ValueError("limit must be positive")
    if limit > HARD_LIMIT:
        raise ValueError(f"limit exceeds hard limit of {HARD_LIMIT}")
    completed_ids = completed_ids or set()
    return [
        item for item in items
        if item.get("approved") is True
        and str(item.get("candidate_id") or "") not in completed_ids
    ][:limit]


def download_one(
    item: dict[str, Any],
    sources: list[Source],
    transports: list[Transport],
    target: Path,
    disabled: set[str] | None = None,
) -> DownloadRecord:
    """Try every (source, transport) pair until one yields a valid PDF."""
    disabled = disabled if disabled is not None else set()
    record = DownloadRecord(
        candidate_id=str(item.get("candidate_id") or ""),
        title=str(item.get("title") or ""),
        outcome=Outcome.NOT_FOUND,
        timestamp=_now(),
    )

    for source in sources:
        for transport in transports:
            if transport.name in disabled or not transport.can_handle(source):
                continue
            try:
                found = transport.fetch(source, target)
                if found is None:
                    # Record it: a silent "nothing here" is the single most
                    # confusing outcome to debug after the fact.
                    record.attempts.append(
                        Attempt(source.url, transport.name, Outcome.NOT_FOUND,
                                "no PDF at this source")
                    )
                    continue
                validate_pdf(target)
            except Exception as error:
                outcome = outcome_of(error)
                record.attempts.append(
                    Attempt(source.url, transport.name, outcome, str(error))
                )
                if outcome is Outcome.DENIED:
                    # The host banned us; every later paper would fail the same
                    # way, so stop using this transport for the whole run.
                    disabled.add(transport.name)
                target.unlink(missing_ok=True)
                continue

            record.outcome = Outcome.DOWNLOADED
            record.pdf_path = str(target.resolve())
            record.sha256 = sha256_file(target)
            record.source_url = found or source.url
            record.attempts.append(
                Attempt(source.url, transport.name, Outcome.DOWNLOADED)
            )
            return record

    # Report the most informative verdict rather than a bare "not found".
    for preferred in (Outcome.DENIED, Outcome.BLOCKED, Outcome.NOT_OPEN_ACCESS,
                      Outcome.ERROR):
        if any(a.outcome is preferred for a in record.attempts):
            record.outcome = preferred
            break
    return record


def plan_sources(
    queue_path: Path,
    run_dir: Path,
    limit: int = DEFAULT_LIMIT,
    resolve_oa: bool = True,
    http_only: bool = False,
) -> list[dict[str, Any]]:
    """What *would* be tried, per paper, without downloading anything.

    Turns "why did this paper not download" into a question answerable before
    the run instead of only from the log afterwards.
    """
    import json

    from academia.litreview.acquire.download import candidate_urls
    from academia.litreview.acquire.transport import needs_browser

    artifact = json.loads(queue_path.read_text(encoding="utf-8"))
    done = set(ledger_mod.verified_downloads(ledger_mod.ledger_path(run_dir)))
    # A plan is a preview, so it covers everything acquisition would consider —
    # the queue is still unapproved at this point.
    pending = [
        item for item in artifact.get("items", [])
        if str(item.get("candidate_id") or "") not in done
    ][:limit]

    plans: list[dict[str, Any]] = []
    for item in pending:
        urls = candidate_urls(item, resolve=resolve_oa)
        sources = []
        for url in urls:
            entry = {"url": url, "transport": "browser" if needs_browser(url) else "http"}
            if http_only and entry["transport"] == "browser":
                entry["degraded"] = True
                entry["note"] = "no-browser mode — will likely fail with challenge"
            sources.append(entry)
        plans.append({
            "candidate_id": str(item.get("candidate_id") or ""),
            "title": str(item.get("title") or ""),
            "sources": sources,
        })
    return plans


def acquire_pdfs(
    queue_path: Path,
    run_dir: Path,
    limit: int = DEFAULT_LIMIT,
    profile: Path | None = None,
    browser_channel: str = "chrome",
    network_mode: str = "direct",
    downloader: Callable[[dict[str, Any], Path, str], str] | None = None,
    resolve_oa: bool = True,
    page_factory: Callable[[], tuple[Any, Callable[[], None]]] | None = None,
    http_only: bool = False,
) -> list[dict[str, Any]]:
    """Download approved PDFs, recording every outcome in the ledger.

    When *http_only* is True, browser transports are globally disabled —
    no Playwright page is launched, no ResearchGate searches are attempted,
    and every paper is tried via plain HTTP. Publisher URLs will typically
    fail with a challenge response, but the failure is logged with the
    URL so the user can retrieve the paper manually.
    """
    import json

    from academia.litreview.acquire.download import candidate_urls

    artifact = json.loads(queue_path.read_text(encoding="utf-8"))
    pdf_dir = run_dir / "pdfs"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    path = ledger_mod.ledger_path(run_dir)

    items = select_pending(
        artifact.get("items", []),
        limit,
        completed_ids=set(ledger_mod.verified_downloads(path)),
    )
    if not items:
        return []

    page: Any | None = None
    close: Callable[[], None] = lambda: None  # noqa: E731
    if downloader is None and not http_only:
        from academia.litreview.acquire.download import playwright_page
        factory = page_factory or (
            lambda: playwright_page(profile, browser_channel, network_mode)
        )
        page, close = factory()

    disabled: set[str] = set()
    results: list[dict[str, Any]] = []
    try:
        for item in items:
            cid = safe_filename(str(item.get("candidate_id") or "paper"), 40)
            title = safe_filename(str(item.get("title") or "paper"), 80)
            target = pdf_dir / f"{cid}_{title}.pdf"

            transports = (
                [_CallableTransport(downloader, item)] if downloader is not None
                else default_transports(page, item, http_only=http_only)
            )
            sources = [Source(url) for url in candidate_urls(item, resolve=resolve_oa)]

            record = download_one(item, sources, transports, target, disabled)
            ledger_mod.append(path, record)
            ledger_mod.write_csv_mirror(path)
            if record.succeeded:
                results.append(record.to_dict())
            else:
                print(f"  {record.candidate_id}: {record.failure_summary()}")
    finally:
        close()
    return results
