"""SQLite connection handling and schema application.

One file, no server. FTS5 supplies BM25, so the first version needs no vector
index; embeddings are an optional column, not an architecture.

The database deliberately lives on local disk rather than in the synced workspace
root — a SQLite file under OneDrive gets corrupted by the sync client.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from academia.core import paths

SCHEMA_VERSION = "1"
SCHEMA_FILE = Path(__file__).with_name("schema.sql")

#: Tables reported by ``academia db stats``, in dependency order.
TABLES = (
    "papers",
    "paper_terms",
    "paper_refs",
    "paper_embeddings",
    "persons",
    "person_names",
    "person_topics",
    "person_ranks",
    "authorships",
    "institutions",
    "affiliations",
    "education",
    "coauthor_edges",
    "manuscripts",
    "manuscript_authors",
    "runs",
    "candidate_scores",
    "coi_evidence",
    "emails",
    "review_history",
)


def _configure(connection: sqlite3.Connection) -> None:
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")


def connect(path: Path | None = None, *, create: bool = True) -> sqlite3.Connection:
    """Open the store, applying the schema when the file is new."""
    target = path or paths.database_path()
    if create:
        target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target)
    _configure(connection)
    if create:
        apply_schema(connection)
    return connection


#: Tables whose contents are re-derivable from the sources, keyed by a column
#: that only the current definition has. ``CREATE TABLE IF NOT EXISTS`` cannot
#: reshape a table that already exists, so a store written by an older build
#: keeps the old columns and every insert fails. Dropping costs one re-fetch.
_DERIVED_TABLES = {"person_topics": "source"}


def _drop_outdated_derived_tables(connection: sqlite3.Connection) -> None:
    for table, required_column in _DERIVED_TABLES.items():
        columns = {
            row[1] for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if columns and required_column not in columns:
            connection.execute(f"DROP TABLE {table}")


#: Columns added to tables that must never be dropped. ``papers`` is the
#: accumulated corpus — the reason a second manuscript in the same field starts
#: with most of the work done — and dropping it would cascade through
#: authorships, terms and references. Added, not rebuilt.
_ADDED_COLUMNS = {
    "papers": (("pdf_url", "TEXT"), ("landing_page_url", "TEXT")),
}


def _add_missing_columns(connection: sqlite3.Connection) -> None:
    for table, columns in _ADDED_COLUMNS.items():
        existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # A new store gets them from schema.sql.
        for name, kind in columns:
            if name not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")


def apply_schema(connection: sqlite3.Connection) -> None:
    """Idempotent: every statement is ``IF NOT EXISTS``."""
    _drop_outdated_derived_tables(connection)
    _add_missing_columns(connection)
    connection.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))
    connection.execute(
        "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SCHEMA_VERSION,),
    )
    connection.commit()


@contextmanager
def session(path: Path | None = None) -> Generator[sqlite3.Connection]:
    """Transactional scope: commit on success, roll back on error."""
    connection = connect(path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize(path: Path | None = None) -> Path:
    target = path or paths.database_path()
    connection = connect(target)
    connection.close()
    return target


def table_counts(path: Path | None = None) -> dict[str, int]:
    with session(path) as connection:
        return {
            table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in TABLES
        }


def vacuum(path: Path | None = None) -> None:
    connection = connect(path)
    try:
        connection.execute("VACUUM")
    finally:
        connection.close()
