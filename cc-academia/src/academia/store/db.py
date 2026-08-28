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


def apply_schema(connection: sqlite3.Connection) -> None:
    """Idempotent: every statement is ``IF NOT EXISTS``."""
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
