"""``ms-review`` — the deterministic half of manuscript review.

Only ingest and status live here. Everything else the workflow does is a model
reading the paper and arguing with itself about it, which belongs in the skill
rather than in a command. The reason this exists at all is that
``skills/manuscript-review/01-ingest.md`` needs a command that will still be
there after the migration; it used to call ``python -m scripts.ingest`` from a
repository layout that no longer exists.
"""

from __future__ import annotations

import argparse

from academia.core import log, paths
from academia.core.errors import EXIT_OK, UsageError
from academia.msreview import ingest as ms_ingest


def run_ingest(args: argparse.Namespace) -> int:
    workspace = ms_ingest.run(args.pdf, slug=args.slug)
    sections = sorted((workspace.text_dir / "md").glob("*.md"))
    payload = {
        "slug": workspace.slug,
        "workspace": str(workspace.root),
        "entry": str(workspace.entry),
        "sections": [p.name for p in sections],
        "next": "read 1-paper-text/paper.md, then 02-literature.md",
    }
    if args.json:
        log.emit(payload)
    else:
        log.info(f"workspace: {workspace.root}")
        log.info(f"  entry   : {workspace.entry}")
        log.info(f"  sections: {len(sections)}")
        log.info(f"  next    : {payload['next']}")
    return EXIT_OK


def run_status(args: argparse.Namespace) -> int:
    root = paths.workspaces_root(ms_ingest.WORKFLOW)
    if args.slug:
        workspace = root / args.slug
        if not workspace.exists():
            raise UsageError(f"workspace not found: {workspace}")
        stages = {
            "pdf": (workspace / ms_ingest.RAW_PDF).exists(),
            "ingested": (workspace / ms_ingest.TEXT_DIR / "paper.md").exists(),
        }
        payload = {"slug": args.slug, "workspace": str(workspace), "stages": stages}
    else:
        slugs = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else []
        payload = {"root": str(root), "workspaces": slugs}

    if args.json:
        log.emit(payload)
    else:
        for key, value in payload.items():
            log.info(f"{key}: {value}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    from academia import __version__

    parser = argparse.ArgumentParser(
        prog="ms-review",
        description="Manuscript review: decompose a submission into reviewable sections.",
    )
    parser.add_argument("--version", action="version", version=f"cc-academia {__version__}")
    sub = parser.add_subparsers(dest="command")

    ingest = sub.add_parser("ingest", help="PDF -> per-section markdown and figures.")
    ingest.add_argument("pdf", help="Manuscript PDF.")
    ingest.add_argument("--slug", help="Workspace name; derived from the filename otherwise.")
    _add_common(ingest)

    status = sub.add_parser("status", help="Show one workspace, or list them all.")
    status.add_argument("--slug")
    _add_common(status)

    return parser


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON on stdout.")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose progress on stderr.")


def handlers() -> dict[str, object]:
    return {"ingest": run_ingest, "status": run_status}
