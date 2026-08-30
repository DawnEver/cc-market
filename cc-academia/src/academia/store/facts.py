"""The part of the store that cannot be re-derived, in a form that can travel.

Most of the database is a cache. Papers, authorships, resolved identities,
OpenAlex affiliations and yearly output all come back by re-running the
pipeline, and a lost store costs a few minutes and a few API calls.

Five things do not come back, because a person paid to establish each one:

* **invitations** — who was asked and how they answered. The only evidence the
  responsiveness rules read, and it can only ever be typed in by an editor.
* **ranks** — a title someone read off a page, with the page.
* **emails** — an address found on a staff page or a corresponding-author
  footnote, with the page.
* **verified affiliations** — a correction to where someone actually works.
* **verified education** — the doctorate years the doctoral-year floor needs.

Those five are exported here as line-oriented JSON, one directory per device, so
that a folder sync can carry them between machines. **The database itself is
never synced**: it is SQLite in WAL mode, whose consistency depends on the
``-wal`` sidecar matching the main file, and a file-level syncer uploads the two
independently. The failure mode is a silently mixed pair, not an error.

Why one directory per device rather than one shared file: two machines then
never write the same path, so the syncer has no conflict to resolve and never
produces a "conflicted copy". Import reads every device's files and merges them,
which makes the format append-only from any single machine's point of view.

Every record carries the identity three ways — ORCID, OpenAlex id and display
name — so a machine that has never harvested the person can still attach the
fact, and so a human reading the diff can tell who it is about.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from academia.core import paths
from academia.core.models import Institution

#: Sources that state a fact rather than infer it. Only these are portable: an
#: OpenAlex affiliation is re-derivable and would just bloat the file.
VERIFIED_SOURCES = ("agent_lookup", "editor_attestation")

TABLES = ("invitations", "ranks", "emails", "affiliations", "education")


@dataclass(frozen=True)
class SyncReport:
    exported: dict[str, int]
    imported: dict[str, int]
    skipped: int = 0
    directory: str = ""

    def total_in(self) -> int:
        return sum(self.imported.values())

    def total_out(self) -> int:
        return sum(self.exported.values())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _identity(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "person_id": row["person_id"],
        "orcid": row["orcid"] or "",
        "openalex_id": row["openalex_id"] or "",
        "display_name": row["display_name"],
    }


_PERSON_JOIN = "JOIN persons p USING (person_id)"


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return list(conn.execute(sql, params))


def collect(conn: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    """Every non-derivable fact this store holds, keyed by table."""
    verified = ",".join("?" for _ in VERIFIED_SOURCES)

    invitations = [
        _identity(r)
        | {
            "ms_id": r["ms_id"],
            "invited_at": r["invited_at"] or "",
            "responded": r["responded"],
            "accepted": r["accepted"],
            "quality_note": r["quality_note"] or "",
        }
        for r in _rows(
            conn,
            f"SELECT h.*, p.orcid, p.openalex_id, p.display_name "
            f"FROM review_history h {_PERSON_JOIN} ORDER BY h.person_id, h.ms_id",
        )
    ]

    ranks = [
        _identity(r) | {"rank": r["rank"], "source_url": r["source_url"] or "", "seen_at": r["seen_at"]}
        for r in _rows(
            conn,
            f"SELECT k.*, p.orcid, p.openalex_id, p.display_name "
            f"FROM person_ranks k {_PERSON_JOIN} ORDER BY k.person_id",
        )
    ]

    emails = [
        _identity(r)
        | {
            "email": r["email"],
            "source": r["source"],
            "source_url": r["source_url"] or "",
            "confidence": r["confidence"],
            "verified_at": r["verified_at"],
        }
        for r in _rows(
            conn,
            f"SELECT e.*, p.orcid, p.openalex_id, p.display_name "
            f"FROM emails e {_PERSON_JOIN} ORDER BY e.person_id, e.email",
        )
    ]

    affiliations = [
        _identity(r)
        | {
            "institution": r["name"],
            "country_code": r["country_code"] or "",
            "department": r["department"] or "",
            "role": r["role"] or "",
            "year_from": r["year_from"],
            "year_to": r["year_to"],
            "is_current": bool(r["is_current"]),
            "source": r["source"],
            "source_url": r["source_url"] or "",
        }
        for r in _rows(
            conn,
            f"SELECT a.*, i.name, i.country_code, p.orcid, p.openalex_id, p.display_name "
            f"FROM affiliations a {_PERSON_JOIN} JOIN institutions i USING (inst_id) "
            f"WHERE a.source IN ({verified}) ORDER BY a.person_id, i.name",
            VERIFIED_SOURCES,
        )
    ]

    education = [
        _identity(r)
        | {
            "institution": r["name"],
            "degree": r["degree"] or "",
            "field": r["field"] or "",
            "year_from": r["year_from"],
            "year_to": r["year_to"],
            "source": r["source"],
            "source_url": r["source_url"] or "",
        }
        for r in _rows(
            conn,
            f"SELECT e.*, i.name, p.orcid, p.openalex_id, p.display_name "
            f"FROM education e {_PERSON_JOIN} JOIN institutions i USING (inst_id) "
            f"WHERE e.source IN ({verified}) ORDER BY e.person_id, i.name, e.degree",
            VERIFIED_SOURCES,
        )
    ]

    return {
        "invitations": invitations,
        "ranks": ranks,
        "emails": emails,
        "affiliations": affiliations,
        "education": education,
    }


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> bool:
    """Write records, returning whether the file actually changed.

    Byte-identical output for unchanged data matters more than it looks: a
    rewrite with a new mtime is a fresh upload for the syncer, and a folder that
    churns every run is one a user turns off.
    """
    body = "".join(
        json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records
    )
    if path.exists() and path.read_text(encoding="utf-8") == body:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return True


def export(conn: sqlite3.Connection, directory: Path | None = None) -> dict[str, int]:
    """Write this device's facts. Never touches another device's directory."""
    base = (directory or paths.facts_dir()) / paths.device_id()
    counts: dict[str, int] = {}
    for table, records in collect(conn).items():
        _write_jsonl(base / f"{table}.jsonl", records)
        counts[table] = len(records)
    (base / "README.txt").write_text(
        "cc-academia portable facts.\n\n"
        "One directory per device; each file is JSON Lines, one fact per line,\n"
        "every fact carrying the URL that stated it. Safe to sync, safe to diff,\n"
        "safe to merge by hand. The SQLite database is NOT synced and must not\n"
        "be: WAL mode makes a file-level syncer corrupt it silently.\n\n"
        f"Last written {_now()} by device '{paths.device_id()}'.\n",
        encoding="utf-8",
    )
    return counts


def _read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue  # a half-synced line is skipped, never fatal
        if isinstance(record, dict):
            yield record


def _resolve_person(conn: sqlite3.Connection, record: dict[str, Any]) -> str | None:
    """Find the local person for a fact, creating a stub only when identified.

    Identity precedence is the store's, not this file's: ORCID, then the
    OpenAlex id, then an id that already exists locally. A fact about a person
    resolved by name alone is dropped rather than guessed onto a namesake —
    inviting the wrong person is worse than not inviting anyone.
    """
    orcid = (record.get("orcid") or "").strip()
    openalex_id = (record.get("openalex_id") or "").strip()
    person_id = (record.get("person_id") or "").strip()

    for column, value in (("orcid", orcid), ("openalex_id", openalex_id)):
        if not value:
            continue
        row = conn.execute(
            f"SELECT person_id FROM persons WHERE {column} = ?", (value,)
        ).fetchone()
        if row:
            return row["person_id"]

    if person_id:
        row = conn.execute(
            "SELECT person_id FROM persons WHERE person_id = ?", (person_id,)
        ).fetchone()
        if row:
            return row["person_id"]

    if not (orcid or openalex_id) or not person_id:
        return None

    now = _now()
    conn.execute(
        """
        INSERT INTO persons (person_id, display_name, orcid, openalex_id, confidence,
                             resolution_method, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(person_id) DO NOTHING
        """,
        (
            person_id,
            record.get("display_name") or "unknown",
            orcid or None,
            openalex_id or None,
            0.99 if orcid else 0.9,
            "orcid" if orcid else "openalex_id",
            now,
            now,
        ),
    )
    return person_id


def _institution_id(conn: sqlite3.Connection, name: str, country_code: str = "") -> str:
    institution = Institution.build(name=name or "institution unknown", country_code=country_code)
    conn.execute(
        """
        INSERT INTO institutions (inst_id, name, country_code)
        VALUES (?, ?, ?)
        ON CONFLICT(inst_id) DO UPDATE SET
            country_code = coalesce(nullif(excluded.country_code, ''), institutions.country_code)
        """,
        (institution.inst_id, institution.name, institution.country_code or None),
    )
    return institution.inst_id


def _apply(conn: sqlite3.Connection, table: str, record: dict[str, Any], person_id: str) -> None:
    """Merge one fact. Every statement is an upsert: import never deletes.

    A row that already exists locally keeps whatever it has that the incoming
    one lacks, so importing an older export cannot blank a source URL.
    """
    if table == "invitations":
        conn.execute(
            """
            INSERT INTO review_history (person_id, ms_id, invited_at, responded, accepted, quality_note)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(person_id, ms_id) DO UPDATE SET
                invited_at   = coalesce(nullif(excluded.invited_at, ''), review_history.invited_at),
                responded    = coalesce(excluded.responded, review_history.responded),
                accepted     = coalesce(excluded.accepted, review_history.accepted),
                quality_note = coalesce(nullif(excluded.quality_note, ''), review_history.quality_note)
            """,
            (
                person_id,
                record["ms_id"],
                record.get("invited_at") or None,
                record.get("responded"),
                record.get("accepted"),
                record.get("quality_note") or None,
            ),
        )
    elif table == "ranks":
        conn.execute(
            """
            INSERT INTO person_ranks (person_id, rank, source_url, seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(person_id) DO UPDATE SET
                rank       = excluded.rank,
                source_url = coalesce(nullif(excluded.source_url, ''), person_ranks.source_url),
                seen_at    = max(excluded.seen_at, person_ranks.seen_at)
            WHERE excluded.seen_at >= person_ranks.seen_at
            """,
            (person_id, record["rank"], record.get("source_url") or None, record.get("seen_at") or _now()),
        )
    elif table == "emails":
        conn.execute(
            """
            INSERT INTO emails (person_id, email, source, source_url, confidence, verified_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(person_id, email) DO UPDATE SET
                source     = excluded.source,
                source_url = coalesce(nullif(excluded.source_url, ''), emails.source_url),
                confidence = max(excluded.confidence, emails.confidence)
            """,
            (
                person_id,
                record["email"],
                record.get("source") or "imported",
                record.get("source_url") or None,
                float(record.get("confidence") or 0.0),
                record.get("verified_at") or _now(),
            ),
        )
    elif table == "affiliations":
        from academia.core.models import Affiliation
        from academia.store import repository

        inst_id = _institution_id(conn, record.get("institution", ""), record.get("country_code", ""))
        # Through the repository rather than a second copy of the SQL: an
        # undated affiliation cannot be upserted by ON CONFLICT, and one bug of
        # that shape is enough.
        repository.record_affiliation(
            conn,
            person_id,
            Affiliation(
                inst_id=inst_id,
                department=record.get("department") or "",
                role=record.get("role") or "",
                year_from=record.get("year_from"),
                year_to=record.get("year_to"),
                is_current=bool(record.get("is_current")),
                source=record.get("source") or "agent_lookup",
                source_url=record.get("source_url") or "",
            ),
        )
    elif table == "education":
        inst_id = _institution_id(conn, record.get("institution", ""))
        conn.execute(
            """
            INSERT INTO education (person_id, inst_id, degree, field, year_from, year_to,
                                   source, source_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(person_id, inst_id, degree) DO UPDATE SET
                field      = coalesce(nullif(excluded.field, ''), education.field),
                year_from  = coalesce(excluded.year_from, education.year_from),
                year_to    = coalesce(excluded.year_to, education.year_to),
                source_url = coalesce(nullif(excluded.source_url, ''), education.source_url)
            """,
            (
                person_id,
                inst_id,
                record.get("degree") or None,
                record.get("field") or None,
                record.get("year_from"),
                record.get("year_to"),
                record.get("source") or "agent_lookup",
                record.get("source_url") or None,
            ),
        )


def import_(conn: sqlite3.Connection, directory: Path | None = None) -> tuple[dict[str, int], int]:
    """Merge every device's facts into this store, including this device's own.

    Returns ``(counts, skipped)``. Skipped means a fact whose person could not
    be identified locally and carried no resolvable id — never a merge failure,
    because there is nothing here that can conflict destructively.
    """
    base = directory or paths.facts_dir()
    counts = {table: 0 for table in TABLES}
    skipped = 0
    if not base.is_dir():
        return counts, skipped

    for device_dir in sorted(p for p in base.iterdir() if p.is_dir()):
        for table in TABLES:
            # A syncer that hits a real conflict leaves "ranks-DESKTOP-1.jsonl"
            # beside "ranks.jsonl". Reading both is how that stops being a loss.
            for path in sorted(device_dir.glob(f"{table}*.jsonl")):
                for record in _read_jsonl(path):
                    person_id = _resolve_person(conn, record)
                    if person_id is None:
                        skipped += 1
                        continue
                    try:
                        _apply(conn, table, record, person_id)
                    except (sqlite3.IntegrityError, KeyError):
                        skipped += 1
                        continue
                    counts[table] += 1
    return counts, skipped


def sync(conn: sqlite3.Connection, directory: Path | None = None) -> SyncReport:
    """Pull every device's facts in, then publish this device's.

    In that order on purpose: exporting after importing means this device's file
    also carries what it just learned from the others, so a third machine that
    only ever sees one directory still converges.
    """
    base = directory or paths.facts_dir()
    imported, skipped = import_(conn, base)
    exported = export(conn, base)
    return SyncReport(exported=exported, imported=imported, skipped=skipped, directory=str(base))
