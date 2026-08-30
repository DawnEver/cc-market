"""``academia doctor`` — is this installation usable, and where does it read/write?

The first thing a playbook runs. It answers the questions that otherwise get
guessed: which plugin root is active, whether the user has config overrides in
play, whether the database exists, and which optional extras are installed.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys

from academia import __version__
from academia.core import log, paths
from academia.core.errors import EXIT_OK

OPTIONAL_MODULES = {
    "ai": "litellm",
    "browser": "playwright",
    "pdf": "paper_pdf_ingest",
    "plot": "matplotlib",
    "embed": "numpy",
}


def _installed(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def collect() -> dict:
    db = paths.database_path()
    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "plugin_root": str(paths.plugin_root()),
        "config_dir_default": str(paths.default_config_dir()),
        "config_dir_override": os.environ.get(paths.ENV_CONFIG_DIR) or None,
        "lens_dir": str(paths.lens_dir()),
        "data_root": str(paths.data_root()),
        "database": {"path": str(db), "exists": db.exists()},
        "facts": {
            "path": str(paths.facts_dir()),
            "device": paths.device_id(),
            "shared_location": bool(os.environ.get(paths.ENV_FACTS_DIR)),
            "enabled": paths.facts_sync_enabled(),
        },
        "contact_email": paths.contact_email() or None,
        "extras": {name: _installed(mod) for name, mod in OPTIONAL_MODULES.items()},
        "s2_api_key": bool(os.environ.get("S2_API_KEY")),
    }


def run(args: argparse.Namespace) -> int:
    report = collect()
    if getattr(args, "json", False):
        log.emit(report)
        return EXIT_OK

    log.info(f"cc-academia {report['version']} (python {report['python']})")
    log.info(f"  plugin root : {report['plugin_root']}")
    log.info(f"  config      : {report['config_dir_default']}")
    if report["config_dir_override"]:
        log.info(f"  override    : {report['config_dir_override']}")
    log.info(f"  lenses      : {report['lens_dir']}")
    log.info(f"  data root   : {report['data_root']}")
    state = "present" if report["database"]["exists"] else "not created"
    log.info(f"  database    : {report['database']['path']} ({state})")
    facts = report["facts"]
    how = "export on" if facts["enabled"] else "export off"
    log.info(f"  facts       : {facts['path']} ({how}, device '{facts['device']}')")
    extras = ", ".join(k for k, v in report["extras"].items() if v) or "none"
    log.info(f"  extras      : {extras}")
    if not report["facts"]["enabled"]:
        log.detail(
            "portable facts are not exported — invitations, verified ranks and "
            "addresses stay in the local store. These are real people's contact "
            "details, so carrying them elsewhere is deliberate: set "
            "ACADEMIA_FACTS_SYNC=1 and ACADEMIA_FACTS_DIR."
        )
    if not report["contact_email"]:
        log.warn("ACADEMIA_CONTACT is unset — OpenAlex/ORCID polite pools give lower rate limits.")
    if not report["s2_api_key"]:
        log.detail("S2_API_KEY unset — Semantic Scholar author endpoints stay disabled.")
    return EXIT_OK


def run_db(args: argparse.Namespace) -> int:
    from academia.store import db as store_db

    command = getattr(args, "db_command", None)
    if command == "init":
        path = store_db.initialize()
        log.info(f"database ready: {path}")
        return EXIT_OK
    if command == "stats":
        stats = store_db.table_counts()
        if getattr(args, "json", False):
            log.emit(stats)
        else:
            for table, count in stats.items():
                log.info(f"  {table:<20} {count}")
        return EXIT_OK
    if command == "vacuum":
        store_db.vacuum()
        log.info("vacuumed")
        return EXIT_OK

    log.error("usage: academia db {init,stats,vacuum}")
    return 2
