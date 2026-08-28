"""Unified CLI entry point for Literature Review.

Macro commands for the 4-phase pipeline + post-acquisition capabilities.
Agent calls high-level commands; CLI handles mechanical steps internally.
"""

from __future__ import annotations

import argparse
import contextlib
import sys
from datetime import UTC
from pathlib import Path

from academia import __version__
from academia.core.paths import workspaces_root
from academia.litreview.acquire.download import (
    COMPLETION_MODES,
    DEFAULT_BROWSER_CHANNEL,
    DEFAULT_NETWORK_MODE,
    SUPPORTED_BROWSER_CHANNELS,
    SUPPORTED_NETWORK_MODES,
    open_login,
)
from academia.litreview.screen import import_agent_screening
from academia.litreview.search import get_source, run_dedupe_rank, run_probe

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SEARCH_CONFIG = {"default_page_size": 25, "max_pages_per_query": 5}
DEFAULT_PAGE_SIZE = 25


RECOMMENDED_WORKFLOW = """Recommended workflow:

  lit-review init <topic>         Create workspace
  lit-review search --topic <s>   Queries -> probe -> search -> dedupe -> screening packet
  lit-review acquire --topic <s>  Queue -> auth -> download -> match -> manifest
  lit-review ingest --topic <s>   On-demand PDF decomposition with cache reuse

Post-acquisition (choose what you need):
  lit-review read --topic <s> --paper <id>   Deep-read with optional domain lens
  lit-review synthesize --topic <s>          Cross-paper synthesis
  lit-review export --topic <s>              Export cards to markdown/CSV/BibTeX
  lit-review stats --topic <s> [--plots]     Summary statistics + charts
  lit-review login                           Browser login for publisher auth
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _topic_dir(slug: str) -> Path:
    """Resolve a topic slug to its workspace directory."""
    d = workspaces_root("literature-review") / slug
    if not d.exists():
        print(f"error: workspace not found: {d}", file=sys.stderr)
        print("Run: lit-review init <topic>", file=sys.stderr)
        raise SystemExit(2)
    return d


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lit-review",
        description="Literature Review - systematic literature review pipeline.",
        epilog=RECOMMENDED_WORKFLOW,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"Literature Review {__version__}")
    sub = parser.add_subparsers(dest="command")

    # === Pipeline: init ===
    p = sub.add_parser("init", help="Create a new workspace for a topic.")
    p.add_argument("topic", help="Topic name or slug.")

    # === Pipeline: search ===
    p = sub.add_parser("search", help="End-to-end: queries -> probe -> search -> dedupe -> screening packet.")
    p.add_argument("--topic", required=True, help="Topic slug (workspaces/<slug>).")
    p.add_argument("--provider", action="append", help="Literature source provider (repeatable; default: all from workspace.toml).")
    p.add_argument("--max-pages", type=int, default=5)
    p.add_argument("--rows-per-page", type=int, default=DEFAULT_PAGE_SIZE)
    p.add_argument("--delay", type=float, default=1.0, help="Seconds between pages.")
    p.add_argument("--probe-only", action="store_true", help="Stop after probe for query adjustment.")
    p.add_argument("--skip-probe", action="store_true", help="Skip probe, go straight to full search.")

    # === Pipeline: acquire ===
    p = sub.add_parser("acquire", help="End-to-end: queue -> auth -> download -> match -> manifest.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--profile", help="Browser profile path for authenticated download.")
    p.add_argument("--browser-channel", choices=["chrome", "chromium"], default="chrome", help="Browser to use (default: chrome for real Chrome with cookies).")
    p.add_argument("--candidate-id", action="append", help="Approve specific candidate (repeatable).")
    p.add_argument("--approved-by", default="user")
    p.add_argument("--queue-only", action="store_true", help="Only build the download queue.")
    p.add_argument("--limit", type=int, default=None, help="Max PDFs to download this run (default: 20).")
    p.add_argument("--no-resolve-oa", action="store_true", help="Skip DOI->open-access mirror lookup.")
    p.add_argument("--http-only", action="store_true", help="HTTP-only mode: skip browser transports entirely. Publisher URLs will fail but are logged for manual retrieval.")
    p.add_argument("--rebuild-queue", action="store_true", help="Force rebuild the download queue from screening (even if it already exists).")
    p.add_argument("--dry-run", action="store_true", help="Print the source plan per paper; download nothing.")

    # === Pipeline: ingest ===
    p = sub.add_parser("ingest", help="On-demand PDF decomposition with cache reuse.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--paper", action="append", dest="paper_ids", help="Specific candidate ID (repeatable).")
    p.add_argument("--dry-run", action="store_true", help="Show what would be decomposed without doing it.")

    # === Agent support: import-screening ===
    p = sub.add_parser("import-screening", help="Validate and merge agent-authored screening batches.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--batch", action="append", required=True, help="Path to batch result JSONL (repeatable).")

    # === Post-acquisition: read ===
    p = sub.add_parser("read", help="Deep-read a paper with optional domain lens.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--paper", required=True, help="Candidate ID to read.")
    p.add_argument("--lens", help="Domain lens name (e.g. power_electronics).")
    p.add_argument("--model", help="Model override for AI reading.")

    # === Post-acquisition: synthesize ===
    p = sub.add_parser("synthesize", help="Cross-paper synthesis from reading cards.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--paper", action="append", dest="paper_ids", help="Specific candidate IDs (repeatable).")
    p.add_argument("--model", help="Model override.")

    # === Post-acquisition: export ===
    p = sub.add_parser("export", help="Export paper cards to various formats.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--format", default="markdown", choices=["markdown", "csv", "bibtex", "json"])
    p.add_argument("--paper", action="append", dest="paper_ids", help="Specific candidate IDs (repeatable).")

    # === Post-acquisition: stats ===
    p = sub.add_parser("stats", help="Summary statistics for the review.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--plots", action="store_true", help="Generate matplotlib plots.")

    # === Zotero: sync ===
    p = sub.add_parser("zotero-sync", help="Batch sync papers to Zotero with registry maintenance.")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--collection", help="Override Zotero collection name (default: workspace slug).")
    p.add_argument("--force", action="store_true", help="Re-sync even if already in registry.")

    # === Zotero: status ===
    p = sub.add_parser("zotero-status", help="Show Zotero registry state for a workspace.")
    p.add_argument("--topic", required=True, help="Topic slug.")

    # === Zotero: import workspace PDFs ===
    p = sub.add_parser(
        "zotero-import",
        help="Import workspace PDFs into the configured Zotero collection (DOI-deduped, registry-updated).",
    )
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--candidate-id", action="append",
                   help="Import only this candidate's PDF (repeatable). Default: all workspace PDFs.")
    p.add_argument("--dry-run", action="store_true", help="Show the dedupe/import plan only.")
    p.add_argument("--force", action="store_true", help="Re-import even if in the registry.")

    # === Zotero: maintenance ===
    p = sub.add_parser(
        "zotero-maintain",
        help="Enrich bare items (document/filename titles) and mirror PDFs into local storage.",
    )
    p.add_argument("--topic", required=True, help="Topic slug (scopes to the workspace collection).")
    p.add_argument("--collection", help="Override Zotero collection name (default: workspace.toml).")
    p.add_argument("--all", dest="whole_library", action="store_true",
                   help="Widen scope from registry items to the whole configured collection.")
    p.add_argument("--dry-run", action="store_true", help="Plan only; no writes.")

    # === Utility: login ===
    p = sub.add_parser("login", help="Open a publisher site in a browser for authentication.")
    p.add_argument("--profile", default="ieee", help="Browser profile name.")
    p.add_argument("--url", default="https://ieeexplore.ieee.org/")
    p.add_argument("--browser-channel", choices=sorted(SUPPORTED_BROWSER_CHANNELS), default=DEFAULT_BROWSER_CHANNEL)
    p.add_argument("--completion", choices=sorted(COMPLETION_MODES), default="browser-close")
    p.add_argument("--network-mode", choices=sorted(SUPPORTED_NETWORK_MODES), default=DEFAULT_NETWORK_MODE)

    # === Utility: repair ===
    p = sub.add_parser("repair", help="Scan files on disk and rebuild pipeline state (ledger, manifest, queue).")
    p.add_argument("--topic", required=True, help="Topic slug.")
    p.add_argument("--dry-run", action="store_true", help="Report what would be done without making changes.")

    # === Micro-commands (kept for debugging / advanced use) ===
    p = sub.add_parser("probe", help="[Advanced] Probe queries against a provider.")
    p.add_argument("--queries", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--provider", default="ieee")
    p.add_argument("--query-id")

    p = sub.add_parser("dedupe-rank", help="[Advanced] Deduplicate and rank candidate JSONL files.")
    p.add_argument("--input", required=True, action="append")
    p.add_argument("--out", required=True)

    return parser


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def _handle_init(args: argparse.Namespace) -> int:
    """Create workspace directory and workspace.toml."""
    import re
    from datetime import datetime

    slug = re.sub(r"[^a-z0-9]+", "-", args.topic.lower()).strip("-")
    ws_dir = workspaces_root("literature-review") / slug

    if ws_dir.exists():
        print(f"Workspace already exists: {ws_dir}")
        return 0

    ws_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("search", "screening", "download", "handoff", "ingest", "reading", "notes", "export"):
        (ws_dir / sub).mkdir(exist_ok=True)

    toml_content = (
        f'workspace_id = "{slug}"\n'
        f'name = "{args.topic}"\n'
        f'description = ""\n'
        f'created_at = "{datetime.now(UTC).isoformat()}"\n'
        f'\n'
        f'lenses = []\n'
        f'providers = ["ieee_xplore"]\n'
        f'pdf_store = ""\n'
        f'parent = ""\n'
        f'\n'
        f'# Zotero: one flat collection per workspace — no nested subcollections.\n'
        f'# The workspace slug IS the collection name.\n'
        f'# zotero_registry.jsonl tracks every paper\'s candidate_id ↔ zotero_key.\n'
        f'[zotero]\n'
        f'collection_key = ""\n'
        f'collection_name = "{slug}"\n'
        f'group_id = ""\n'
        f'sync_notes = true\n'
        f'sync_attachments = true\n'
        f'tags = []\n'
        f'\n'
        f'[defaults]\n'
        f'year_from = 2018\n'
        f'year_to = 2026\n'
        f'content_types = ["Journals", "Conferences"]\n'
        f'preferred_venues = []\n'
    )
    (ws_dir / "workspace.toml").write_text(toml_content, encoding="utf-8")
    print(f"Created workspace: {ws_dir}")
    return 0


def _handle_search(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_search import run_search as do_search
        result = do_search(
            td,
            provider=args.provider if args.provider else None,
            max_pages=args.max_pages,
            rows_per_page=args.rows_per_page,
            delay_seconds=args.delay,
            probe_only=args.probe_only,
            skip_probe=args.skip_probe,
        )
        print(f"search: candidates={result.get('candidates_count', 0)}")
        failures = result.get("failures") or []
        for f in failures:
            print(f"warning: {f['provider']} {f['stage']} failed: {f['error']}", file=sys.stderr)
        if failures and not result.get("candidates_count"):
            return 1
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_acquire(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        if args.dry_run:
            from academia.litreview.acquire.engine import HARD_LIMIT, plan_sources
            from academia.litreview.acquire_pipeline import write_download_queue

            if args.rebuild_queue or not (td / "download" / "download_queue.json").exists():
                write_download_queue(td / "screening" / "screening_stage1.jsonl", td / "download")
            plans = plan_sources(
                td / "download" / "download_queue.json", td,
                limit=args.limit or HARD_LIMIT,
                resolve_oa=not args.no_resolve_oa,
                http_only=args.http_only,
            )
            for plan in plans:
                print(f"\n{plan['candidate_id']}: {plan['title'][:70]}")
                for source in plan["sources"] or [{"url": "(no source)", "transport": "-"}]:
                    print(f"  [{source['transport']:>7}] {source['url'][:110]}")
            print(f"\n{len(plans)} paper(s) planned; nothing downloaded.")
            if args.http_only:
                print("(http-only mode: browser transports skipped)")
            return 0

        from academia.litreview.workflow_acquire import run_acquire as do_acquire
        result = do_acquire(
            td,
            profile=args.profile,
            browser_channel=args.browser_channel,
            queue_only=args.queue_only,
            candidate_ids=args.candidate_id,
            approved_by=args.approved_by,
            limit=args.limit,
            resolve_oa=not args.no_resolve_oa,
            http_only=args.http_only,
            rebuild_queue=args.rebuild_queue,
        )
        print(f"acquire: downloaded={result.get('downloaded', 0)}, manifest={result.get('manifest_path', 'none')}")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_ingest(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_ingest import run_ingest as do_ingest
        result = do_ingest(
            td,
            paper_ids=args.paper_ids,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            print(f"ingest (dry-run): pending={result.get('pending', 0)}, cached={result.get('skipped', 0)}")
        else:
            print(f"ingest: ok={result.get('succeeded', 0)}, fail={result.get('failed', 0)}, skip={result.get('skipped', 0)}")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_import_screening(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    candidates_path = td / "search" / "candidates_ranked.jsonl"
    out_dir = td / "screening"
    if not candidates_path.exists():
        print(f"error: {candidates_path} not found. Run search first.", file=sys.stderr)
        return 2
    # Migrate away a stale directory left by the pre-fix code, which passed the
    # full file path as `out_dir` and thereby created a DIRECTORY at
    # screening/screening_stage1.jsonl/ with the real file nested inside.
    # Downstream readers open that same path as a file, so leaving it behind
    # turns the next acquire/repair run into an IsADirectoryError.
    import shutil
    stale = out_dir / "screening_stage1.jsonl"
    if stale.is_dir():
        nested = stale / "screening_stage1.jsonl"
        if not nested.is_file():
            raise SystemExit(
                f"error: {stale} is a directory from the old import-screening bug "
                "with no nested screening_stage1.jsonl to migrate — remove it manually."
            )
        # os.replace cannot move a file onto an existing directory on Windows.
        # Stage the file in a sibling path, drop the directory, then hoist.
        staged = out_dir / "screening_stage1.jsonl.migrating"
        nested.replace(staged)
        shutil.rmtree(stale)
        staged.replace(out_dir / "screening_stage1.jsonl")
        print("migrated stale screening_stage1.jsonl directory from pre-fix state")
    try:
        n = import_agent_screening(candidates_path, [Path(p) for p in args.batch], out_dir)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"import-screening: merged={n}")
    return 0


def _handle_read(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_read import run_read as do_read
        card = do_read(td, args.paper, lens=args.lens, model=args.model)
        print(f"read: verdict={card.get('verdict', '?')}, confidence={card.get('confidence', 0):.0%}")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_synthesize(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_read import run_synthesize as do_synth
        synthesis = do_synth(td, paper_ids=args.paper_ids, model=args.model)
        print(synthesis[:500] + ("..." if len(synthesis) > 500 else ""))
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_export(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_export import run_export as do_export
        out = do_export(td, format=args.format, paper_ids=args.paper_ids)
        print(f"exported: {out}")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_stats(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.workflow_export import run_stats as do_stats
        stats = do_stats(td, plots=args.plots)
        import json
        print(json.dumps(stats, indent=2, ensure_ascii=True, default=str))
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_zotero_sync(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.zotero.zotero import sync_papers

        # Build paper list from screening decisions
        screening_path = td / "screening" / "screening_stage1.jsonl"
        if not screening_path.exists():
            # Try screening_stage2
            screening_path = td / "screening" / "screening_stage2.jsonl"
        if not screening_path.exists():
            print("error: no screening file found. Run search + screen first.", file=sys.stderr)
            return 2

        import json
        screening = []
        for line in screening_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            with contextlib.suppress(json.JSONDecodeError):
                screening.append(json.loads(line))

        # Only sync included/maybe papers
        to_sync = [
            s for s in screening
            if s.get("decision") in ("include", "maybe")
        ]
        if not to_sync:
            print("No papers with decision 'include' or 'maybe' to sync.")
            return 0

        print(f"Syncing {len(to_sync)} papers to Zotero...\n")
        results = sync_papers(
            to_sync,
            workspace_dir=td,
            collection=args.collection,
            skip_existing=not args.force,
        )

        ok = sum(1 for r in results if r.item_key and not r.error)
        skipped = sum(1 for r in results if "already synced" in r.error)
        errors = sum(1 for r in results if r.error and "already synced" not in r.error)
        print(f"\nDone: {ok} synced, {skipped} skipped, {errors} errors")
        return 0 if errors == 0 else 1
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_zotero_status(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.zotero.zotero import registry_summary

        summary = registry_summary(td)
        print(f"Workspace: {td.name}")
        print(f"Registry:  {summary['registry_path']}")
        print(f"Synced:    {summary['total_synced']} papers")
        print(f"  with PDF:  {summary['pdf_attached']}")
        print(f"  with notes:{summary['notes_synced']}")
        if summary["entries"]:
            print(f"\n{'ID':<24s} {'Zotero Key':<10s} {'Title':<60s} {'PDF':<5s}")
            print("-" * 103)
            for e in summary["entries"]:
                title = (e.get("title", "") or "")[:58]
                pdf = "✓" if e.get("pdf_attached") else "—"
                print(f"{e['candidate_id']:<24s} {e.get('zotero_key', ''):<10s} {title:<60s} {pdf:<5s}")
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_zotero_import(args: argparse.Namespace) -> int:
    import os

    import rtoml

    from academia.litreview.zotero import zotero_maintenance as zm
    from academia.litreview.zotero.zotero_import import import_workspace_pdfs

    zm.load_dotenv()
    api_key = os.environ.get("ZOTERO_API_KEY")
    library_id = os.environ.get("ZOTERO_LIBRARY_ID")
    library_type = os.environ.get("ZOTERO_LIBRARY_TYPE", "user")
    if not args.dry_run and (not api_key or not library_id):
        print("error: ZOTERO_API_KEY / ZOTERO_LIBRARY_ID not set (check .env)", file=sys.stderr)
        return 2

    td = _topic_dir(args.topic)
    ws = rtoml.load(td / "workspace.toml") if (td / "workspace.toml").exists() else {}
    zconf = ws.get("zotero", {})
    tags = zconf.get("tags") or [args.topic]
    collection_key = None
    if not args.dry_run:
        collection_key = zconf.get("collection_key") or None
        if not collection_key and zconf.get("collection_name"):
            collection_key = zm.find_collection_key(zconf["collection_name"], library_id,
                                                    api_key, library_type)
            if not collection_key:
                print(f"error: Zotero collection not found: {zconf['collection_name']!r}",
                      file=sys.stderr)
                return 2

    results = import_workspace_pdfs(
        td, library_id, api_key, library_type,
        collection_key=collection_key, tags=tags,
        dry_run=args.dry_run, force=args.force,
        candidate_ids=args.candidate_id,
    )
    for r in results:
        line = f"  [{r.action}] {r.canonical}"
        if r.zotero_key:
            line += f" -> {r.zotero_key}"
        if r.duplicates:
            line += f" (+{r.duplicates} dup)"
        if r.action == "error":
            line += f"  ERROR: {r.detail}"
        print(line)
    counts: dict[str, int] = {}
    for r in results:
        counts[r.action] = counts.get(r.action, 0) + 1
    print(f"\nImport: {counts}")
    if not args.dry_run:
        print("Next: lit-review zotero-maintain --topic <slug>, then zotero_update_search_database (MCP)")
    return 0 if counts.get("error", 0) == 0 else 1


def _handle_zotero_maintain(args: argparse.Namespace) -> int:
    import os

    import rtoml

    from academia.litreview.zotero import zotero_maintenance as zm

    zm.load_dotenv()
    api_key = os.environ.get("ZOTERO_API_KEY")
    library_id = os.environ.get("ZOTERO_LIBRARY_ID")
    library_type = os.environ.get("ZOTERO_LIBRARY_TYPE", "user")
    if not api_key or not library_id:
        print("error: ZOTERO_API_KEY / ZOTERO_LIBRARY_ID not set (check .env)", file=sys.stderr)
        return 2

    collection_key = None
    collection_name = None
    td = _topic_dir(args.topic)
    ws = rtoml.load(td / "workspace.toml") if (td / "workspace.toml").exists() else {}
    zconf = ws.get("zotero", {})
    collection_name = args.collection or zconf.get("collection_name") or args.topic
    # Prefer an explicit key: collection names are not unique in Zotero.
    collection_key = zconf.get("collection_key") or None
    if not collection_key:
        collection_key = zm.find_collection_key(collection_name, library_id,
                                                api_key, library_type)
    if not collection_key:
        print(f"error: Zotero collection not found: {collection_name!r}", file=sys.stderr)
        return 2
    print(f"Collection: {collection_name} ({collection_key})")

    # Scope: registry items by default; --all widens to the whole collection.
    # An empty registry must mean "nothing to maintain" — never fall back to
    # an unscoped run against the shared collection.
    only_keys: set[str] | None = None
    if not args.whole_library:
        from academia.litreview.zotero.zotero import load_registry

        only_keys = {e["zotero_key"] for e in load_registry(td) if e.get("zotero_key")}
        print(f"Scope: {len(only_keys)} registry items (use --all for the whole collection)")
        if not only_keys:
            print("Registry is empty — nothing to maintain. Run zotero-import first, or --all.")
            return 0

    scope = "whole collection" if args.whole_library else "registry"
    print(f"Enriching bare items ({scope}){' [dry-run]' if args.dry_run else ''}...")
    results = zm.enrich_items(library_id, api_key, library_type, collection_key,
                              dry_run=args.dry_run, only_keys=only_keys)
    for r in results:
        mark = "✓" if r.applied else ("·" if r.action == "no-match" else "✗")
        print(f"  {mark} {r.key} [{r.action}] {r.title_before[:50]}"
              + (f" -> {r.detail[:60]}" if r.detail and r.applied else ""))
    applied = sum(1 for r in results if r.applied)
    print(f"Enrich: {applied} updated, {sum(1 for r in results if r.action == 'no-match')} no-match, "
          f"{sum(1 for r in results if r.action == 'error')} errors")

    print("Mirroring attachment files to local storage...")
    mirrors = zm.mirror_attachments(library_id, api_key, library_type, collection_key,
                                    dry_run=args.dry_run, only_keys=only_keys)
    for r in mirrors:
        if r.status in ("downloaded", "error"):
            print(f"  {r.status}: {r.key}/{r.filename} {r.detail}")
    counts = {}
    for r in mirrors:
        counts[r.status] = counts.get(r.status, 0) + 1
    print(f"Mirror: {counts}")
    return 0


def _handle_login(args: argparse.Namespace) -> int:
    profile = Path(args.profile)
    if not profile.is_absolute():
        import os
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        profile = Path(base) / "literature-review" / "browser-profiles" / args.profile
    return open_login(
        profile, args.url,
        browser_channel=args.browser_channel,
        completion=args.completion,
        network_mode=args.network_mode,
    )


def _handle_repair(args: argparse.Namespace) -> int:
    td = _topic_dir(args.topic)
    try:
        from academia.litreview.repair import repair_workspace

        result = repair_workspace(td, dry_run=args.dry_run)
        for action in result.get("actions", []):
            print(action)
        print(result.get("status_table", ""))
        return 0
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_probe(args: argparse.Namespace) -> int:
    try:
        provider = get_source(args.provider)
        return run_probe(
            queries_path=Path(args.queries), out_dir=Path(args.out),
            provider=provider, query_id=args.query_id,
            allow_unapproved_plan=True,
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _handle_dedupe_rank(args: argparse.Namespace) -> int:
    return run_dedupe_rank([Path(p) for p in args.input], Path(args.out))


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

_HANDLERS: dict[str, object] = {
    "init": _handle_init,
    "search": _handle_search,
    "acquire": _handle_acquire,
    "ingest": _handle_ingest,
    "import-screening": _handle_import_screening,
    "read": _handle_read,
    "synthesize": _handle_synthesize,
    "export": _handle_export,
    "stats": _handle_stats,
    "login": _handle_login,
    "zotero-sync": _handle_zotero_sync,
    "zotero-status": _handle_zotero_status,
    "zotero-import": _handle_zotero_import,
    "zotero-maintain": _handle_zotero_maintain,
    "repair": _handle_repair,
    "probe": _handle_probe,
    "dedupe-rank": _handle_dedupe_rank,
}


def handlers() -> dict[str, object]:
    """Command table, consumed by the shared dispatcher in ``cli.dispatch``.

    Error handling, exit codes and ``--json`` live there so all three console
    scripts behave the same way.
    """
    return dict(_HANDLERS)
