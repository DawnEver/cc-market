"""Zotero sync — priority chain: zotero-mcp → SQLite → Better BibTeX CAYW.

Principles:
  - One workspace → one flat Zotero collection (no nested subcollections).
  - Zotero is for human reading & PDF storage, not complex taxonomy.
  - The workspace's zotero_registry.jsonl is the bridge — it tracks every
    paper's candidate_id ↔ zotero_key mapping.
  - Agent uses MCP tools directly for interactive operations
  this module
    handles batch sync from the CLI.

Backends (priority order):
  1. zotero-mcp (54yyyu/zotero-mcp) — full read/write while Zotero runs.
  2. SQLite — direct DB writes with PDF
  Zotero must be CLOSED.
  3. Better BibTeX CAYW — citation-only import
  no PDF attachment.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# ── Zotero schema constants ──────────────────────────────────────────
ITEM_TYPE_JOURNAL = 22
CREATOR_TYPE_AUTHOR = 8
F_TITLE = 1
F_ABSTRACT = 2
F_DATE = 6
F_URL = 13
F_ACCESS_DATE = 14
F_VOLUME = 19
F_PAGES = 32
F_PUBLICATION = 38
F_DOI = 59
F_ISSUE = 76

ZOTERO_DB = Path.home() / "Zotero" / "zotero.sqlite"
BBT_CAYW_URL = "http://127.0.0.1:23119/better-bibtex/cayw"

# Default HTTP port for zotero-mcp serve
MCP_DEFAULT_PORT = 8484
MCP_HTTP_BASE = f"http://127.0.0.1:{MCP_DEFAULT_PORT}"
# Use uv tool run for cross-platform portability — identical to .mcp.json config.
# NOTE: the CLI entry point is "zotero-mcp", NOT "pyzotero-mcp" (that name
# belongs to the much smaller read-only `pyzotero` dependency package and
# silently resolves to the wrong, write-less server).
MCP_CMD = "uv"
MCP_ARGS = ["tool", "run", "--from", "zotero-mcp-server==0.6.3", "zotero-mcp"]


# ── Per-paper result ─────────────────────────────────────────────────

@dataclass
class SyncResult:
    paper_index: int
    title: str
    backend: str          # "zotero_mcp" | "sqlite" | "cayw"
    item_key: str = ""
    attachment: bool = False
    error: str = ""


# ── zotero-mcp client (stdio + HTTP) ─────────────────────────────────

class ZoteroMCPError(Exception):
    """Error from the zotero-mcp server."""
    def __init__(self, message: str, code: int = -1):
        super().__init__(f"[zotero-mcp] {message}")
        self.code = code


class ZoteroMCPClient:
    """Client for the 54yyyu/zotero-mcp MCP server.

    Supports two transports:
      - stdio: spawn ``zotero-mcp serve --transport stdio``
      - http:  connect to ``zotero-mcp serve --transport streamable-http --port N``

    Tool names are the well-known names from the 54yyyu/zotero-mcp repo.
    """

    def __init__(self, http_url: str | None = None, timeout: float = 30.0):
        self._http_url = http_url or MCP_HTTP_BASE
        self._timeout = timeout
        self._req_id = 0
        self._proc: subprocess.Popen | None = None
        self._stdio_lock = threading.Lock()
        self._initialized = False

    # ── low-level JSON-RPC ───────────────────────────────────────

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _http_rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send JSON-RPC via HTTP POST."""
        payload = {"jsonrpc": "2.0", "id": self._next_id(), "method": method,
                    "params": params or {}}
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self._http_url}/mcp",
            data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
        except urllib.error.URLError as e:
            raise ZoteroMCPError(f"Connection failed: {e.reason}") from e
        except OSError as e:
            raise ZoteroMCPError(f"OS error: {e}") from e
        if "error" in body:
            err = body["error"]
            raise ZoteroMCPError(err.get("message", "?"), err.get("code", -1))
        return body.get("result", body)

    def _stdio_rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send JSON-RPC via spawned subprocess stdio."""
        if not self._proc or self._proc.poll() is not None:
            raise ZoteroMCPError("stdio process not running")

        payload = {"jsonrpc": "2.0", "id": self._next_id(), "method": method,
                    "params": params or {}}
        line = json.dumps(payload) + "\n"

        with self._stdio_lock:
            try:
                self._proc.stdin.write(line.encode("utf-8"))  # type: ignore[union-attr]
                self._proc.stdin.flush()  # type: ignore[union-attr]
                response_line = self._proc.stdout.readline()  # type: ignore[union-attr]
                body = json.loads(response_line)
            except (BrokenPipeError, json.JSONDecodeError) as e:
                raise ZoteroMCPError(f"stdio communication failed: {e}") from e

        if "error" in body:
            err = body["error"]
            raise ZoteroMCPError(err.get("message", "?"), err.get("code", -1))
        return body.get("result", body)

    def _rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._proc and self._proc.poll() is None:
            return self._stdio_rpc(method, params)
        return self._http_rpc(method, params)

    # ── lifecycle ────────────────────────────────────────────────

    def available(self) -> bool:
        """Check whether zotero-mcp can be reached.

        Tries HTTP first (quick 2s check), then stdio spawn.
        """
        # 1) Quick HTTP check
        try:
            req = urllib.request.Request(f"{self._http_url}/mcp", method="HEAD")
            with urllib.request.urlopen(req, timeout=2):
                pass
            # If reachable, do full initialize
            self._http_rpc("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "lit-review", "version": "1.0"},
            })
            self._initialized = True
            return True
        except Exception:
            pass

        # 2) Try spawning stdio process
        try:
            self._proc = subprocess.Popen(
                [MCP_CMD, *MCP_ARGS, "serve", "--transport", "stdio"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            time.sleep(0.5)
            if self._proc.poll() is not None:
                self._proc = None
                return False
            self._stdio_rpc("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "lit-review", "version": "1.0"},
            })
            self._stdio_rpc("notifications/initialized", {})
            self._initialized = True
            return True
        except (ZoteroMCPError, FileNotFoundError, OSError):
            self._cleanup_proc()
            return False

    def _cleanup_proc(self) -> None:
        if self._proc:
            try:
                self._proc.stdin.close()
                self._proc.stdout.close()
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                with contextlib.suppress(Exception):
                    self._proc.kill()
            self._proc = None

    def close(self) -> None:
        """Shut down the stdio subprocess if running."""
        self._cleanup_proc()

    # ── well-known tool calls ────────────────────────────────────

    def _call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self._rpc("tools/call", {"name": tool, "arguments": arguments})

    def import_pdf(self, pdf_path: Path, collection: str = "Literature Review") -> str | None:
        """Import a PDF file; Zotero extracts metadata automatically.

        Uses ``zotero_add_from_file``. Returns the Zotero item key.
        """
        abs_path = str(pdf_path.resolve())
        result = self._call("zotero_add_from_file", {
            "path": abs_path,
            "collections": [collection],
            "create_missing_collections": True,
            "if_exists": "skip",
        })
        return _extract_key(result)

    def add_by_doi(self, doi: str, pdf_path: str | None = None,
                   collection: str = "Literature Review") -> str | None:
        """Add a paper by DOI; the OA PDF cascade runs automatically.

        Uses ``zotero_add_by_doi``. If *pdf_path* is provided and no OA PDF
        is found, the local PDF is attached via ``zotero_add_from_file``.
        """
        result = self._call("zotero_add_by_doi", {
            "doi": doi,
            "collections": [collection],
            "create_missing_collections": True,
            "if_exists": "skip",
        })
        key = _extract_key(result)
        if key and pdf_path and Path(pdf_path).exists():
            # Attach local PDF if OA cascade didn't find one
            with contextlib.suppress(ZoteroMCPError):
                self._call("zotero_add_from_file", {
                    "path": str(Path(pdf_path).resolve()),
                    "collections": [collection],
                })
        return key

    def add_by_bibtex(self, bibtex: str, collection: str = "Literature Review") -> str | None:
        """Add a paper via BibTeX."""
        result = self._call("zotero_add_by_bibtex", {
            "bibtex": bibtex,
            "collections": [collection],
            "create_missing_collections": True,
            "if_exists": "skip",
        })
        return _extract_key(result)

    def ensure_collection(self, name: str) -> bool:
        """Create a collection if it doesn't exist (idempotent)."""
        try:
            self._call("zotero_create_collection", {"name": name})
            return True
        except ZoteroMCPError:
            return False  # already exists

    def add_to_collection(self, item_key: str, collection: str) -> bool:
        """Add an item to a collection."""
        try:
            self._call("zotero_manage_collections", {
                "action": "add",
                "item_keys": [item_key],
                "collection": collection,
            })
            return True
        except ZoteroMCPError:
            return False


def _extract_key(result: dict[str, Any]) -> str | None:
    """Extract a Zotero item key from a tool result, trying common fields."""
    key = (
        result.get("key")
        or result.get("itemKey")
        or result.get("item_key")
    )
    if key:
        return str(key)
    # Some tools return a list of results
    items = result.get("items") or result.get("results") or []
    if isinstance(items, list) and items:
        first = items[0]
        if isinstance(first, dict):
            key = first.get("key") or first.get("itemKey")
            if key:
                return str(key)
    return None


# ── SQLite helpers ────────────────────────────────────────────────────

def _zotero_key() -> str:
    raw = uuid.uuid4().hex.encode()
    return hashlib.md5(raw).hexdigest()[:8].upper()


def _ensure_value(conn: sqlite3.Connection, value: str) -> int:
    c = conn.cursor()
    c.execute("SELECT valueID FROM itemDataValues WHERE value=?", (value,))
    if (row := c.fetchone()):
        return row[0]
    c.execute("INSERT INTO itemDataValues (value) VALUES (?)", (value,))
    return c.lastrowid


def _set_field(conn: sqlite3.Connection, item_id: int, field_id: int, value: str) -> None:
    if not value:
        return
    vid = _ensure_value(conn, value)
    conn.execute("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)",
                 (item_id, field_id, vid))


def _add_creator(conn: sqlite3.Connection, item_id: int, full_name: str,
                 order_index: int, creator_type: int = CREATOR_TYPE_AUTHOR) -> None:
    name = full_name.strip()
    if not name:
        return
    if "," in name:
        last, _, first = name.partition(",")
        last = last.strip()
        first = first.strip()
    else:
        parts = name.split()
        first = " ".join(parts[:-1]) if len(parts) >= 2 else ""
        last = parts[-1] if parts else name
    c = conn.cursor()
    c.execute("SELECT creatorID FROM creators WHERE firstName=? AND lastName=?", (first, last))
    row = c.fetchone()
    cid = row[0] if row else (
        c.execute("INSERT INTO creators (firstName, lastName) VALUES (?, ?)", (first, last))
        or c.lastrowid
    )
    c.execute("INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) "
              "VALUES (?, ?, ?, ?)", (item_id, cid, creator_type, order_index))


def _storage_dir() -> Path:
    import glob as _g
    profiles = _g.glob(str(ZOTERO_DB.parent / "Profiles" / "*"))
    if profiles:
        return Path(profiles[0]) / "storage"
    s = ZOTERO_DB.parent / "storage"
    if s.exists():
        return s
    raise FileNotFoundError("Cannot find Zotero storage directory")


def _sqlite_add_paper(conn: sqlite3.Connection, *, title: str,
                      authors: list[str] | None = None, abstract: str = "",
                      year: int | None = None, venue: str = "", doi: str = "",
                      url: str = "", pdf_path: str | None = None,
                      item_type: int = ITEM_TYPE_JOURNAL) -> tuple[int, str]:
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    zkey = _zotero_key()
    c = conn.cursor()
    c.execute("INSERT INTO items (itemTypeID, key, libraryID, dateAdded, dateModified, "
              "clientDateModified, version) VALUES (?, ?, ?, ?, ?, ?, 0)",
              (item_type, zkey, 1, now, now, now))
    item_id = c.lastrowid
    for fid, val in [(F_TITLE, title), (F_ABSTRACT, abstract),
                     (F_DATE, str(year) if year else ""), (F_PUBLICATION, venue),
                     (F_DOI, doi), (F_URL, url), (F_ACCESS_DATE, now[:10])]:
        _set_field(conn, item_id, fid, val)
    if authors:
        for i, a in enumerate(authors):
            _add_creator(conn, item_id, a, i)
    if pdf_path and Path(pdf_path).exists():
        pf = Path(pdf_path)
        pdf_key = _zotero_key()
        c.execute("INSERT INTO items (itemTypeID, key, libraryID, dateAdded, dateModified, "
                  "clientDateModified, version) VALUES (?, ?, ?, ?, ?, ?, 0)",
                  (3, pdf_key, 1, now, now, now))
        aid = c.lastrowid
        c.execute("INSERT INTO itemAttachments (itemID, parentItemID, linkMode, "
                  "contentType, path, syncState) VALUES (?, ?, 0, 'application/pdf', ?, 0)",
                  (aid, item_id, f"storage:{pf.name}"))
        _set_field(conn, aid, 1, pf.name)
        storage = _storage_dir() / pdf_key
        storage.mkdir(parents=True, exist_ok=True)
        dest = storage / pf.name
        if not dest.exists():
            shutil.copy2(pf, dest)
    return item_id, zkey


def _sqlite_add_to_collection(conn: sqlite3.Connection, item_id: int, collection_id: int) -> None:
    c = conn.cursor()
    c.execute("SELECT MAX(orderIndex) FROM collectionItems WHERE collectionID=?", (collection_id,))
    row = c.fetchone()
    c.execute("INSERT INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)",
              (collection_id, item_id, (row[0] or 0) + 1))


def _sqlite_find_or_create_collection(conn: sqlite3.Connection, name: str) -> int:
    c = conn.cursor()
    c.execute("SELECT collectionID FROM collections WHERE collectionName=? AND libraryID=?",
              (name, 1))
    if (row := c.fetchone()):
        return row[0]
    c.execute("INSERT INTO collections (collectionName, libraryID, version) VALUES (?, ?, 0)",
              (name, 1))
    return c.lastrowid


def _sqlite_available() -> bool:
    try:
        conn = sqlite3.connect(str(ZOTERO_DB))
        conn.execute("SELECT 1 FROM items LIMIT 1")
        conn.close()
        return True
    except sqlite3.OperationalError:
        return False


# ── CAYW ──────────────────────────────────────────────────────────────

def _paper_to_bibtex(paper: dict[str, Any], cite_key: str) -> str:
    authors = paper.get("authors", [])
    author_str = " and ".join(authors) if authors else "Unknown"
    lines = [f"@article{{{cite_key},",
             f"  title = {{{paper.get('title', '')}}},",
             f"  author = {{{author_str}}},"]
    if paper.get("year"):
        lines.append(f"  year = {{{paper['year']}}},")
    if paper.get("venue"):
        lines.append(f"  journal = {{{paper['venue']}}},")
    if paper.get("doi"):
        lines.append(f"  doi = {{{paper['doi']}}},")
    if paper.get("url"):
        lines.append(f"  url = {{{paper['url']}}},")
    if a := paper.get("abstract", ""):
        lines.append(f"  abstract = {{{a[:500]}}},")
    lines.append("}")
    return "\n".join(lines)


def _cayw_import(bibtex: str) -> bool:
    req = urllib.request.Request(
        f"{BBT_CAYW_URL}?progid=lit-review",
        data=bibtex.encode("utf-8"),
        headers={"Content-Type": "text/plain"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except (urllib.error.HTTPError, OSError):
        return False


def _cayw_available() -> bool:
    try:
        urllib.request.urlopen(urllib.request.Request(BBT_CAYW_URL, method="HEAD"), timeout=2)
        return True
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False


# ── Registry (workspace ↔ Zotero bridge) ────────────────────────────────

REGISTRY_FILENAME = "zotero_registry.jsonl"


def registry_path(workspace_dir: Path) -> Path:
    """Path to the zotero_registry.jsonl for a workspace."""
    return workspace_dir / REGISTRY_FILENAME


def load_registry(workspace_dir: Path) -> list[dict[str, Any]]:
    """Load the Zotero registry for a workspace. Returns [] if missing."""
    rp = registry_path(workspace_dir)
    if not rp.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in rp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            with contextlib.suppress(json.JSONDecodeError):
                entries.append(json.loads(line))
    return entries


def save_registry(workspace_dir: Path, entries: list[dict[str, Any]]) -> Path:
    """Atomically write the registry file."""
    rp = registry_path(workspace_dir)
    tmp = rp.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=True) + "\n")
    tmp.replace(rp)
    return rp


def find_in_registry(entries: list[dict[str, Any]], candidate_id: str) -> dict[str, Any] | None:
    """Find a registry entry by candidate_id. Returns None if not found."""
    for e in entries:
        if e.get("candidate_id") == candidate_id:
            return e
    return None


def upsert_registry(entries: list[dict[str, Any]], new_entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Add or replace a registry entry keyed by candidate_id. Returns mutated list."""
    cid = new_entry["candidate_id"]
    for i, e in enumerate(entries):
        if e.get("candidate_id") == cid:
            entries[i] = new_entry
            return entries
    entries.append(new_entry)
    return entries


def registry_summary(workspace_dir: Path) -> dict[str, Any]:
    """Quick summary of the registry state."""
    entries = load_registry(workspace_dir)
    total = len(entries)
    with_pdf = sum(1 for e in entries if e.get("pdf_attached"))
    with_notes = sum(1 for e in entries if e.get("notes_synced"))
    return {
        "registry_path": str(registry_path(workspace_dir)),
        "total_synced": total,
        "pdf_attached": with_pdf,
        "notes_synced": with_notes,
        "entries": entries,
    }


# ── Dedup helpers ─────────────────────────────────────────────────────

def _dedup_key(paper: dict[str, Any]) -> str | None:
    doi = str(paper.get("doi", "")).strip().lower()
    if doi:
        return f"doi:{doi}"
    arxiv = str((paper.get("provider_raw") or {}).get("arxiv_id", "")).strip()
    if arxiv:
        return f"arxiv:{arxiv}"
    title = str(paper.get("title", "")).strip().lower()
    year = paper.get("year", "")
    if title:
        return f"title:{title[:80]}|{year}"
    return None


def _validate_pdf(pdf_path: str | None, expected_sha256: str | None = None) -> bool:
    if not pdf_path:
        return False
    p = Path(pdf_path)
    if not p.is_file() or p.stat().st_size < 100:
        return False
    with p.open("rb") as f:
        if f.read(4) != b"%PDF":
            return False
    return not (expected_sha256 and hashlib.sha256(p.read_bytes()).hexdigest() != expected_sha256)


# ── Main sync ─────────────────────────────────────────────────────────

def _derive_collection_name(workspace_dir: Path) -> str:
    """Derive the Zotero collection name from the workspace directory name.

    The workspace slug IS the collection name — simple, flat, predictable.
    """
    return workspace_dir.name


def _paper_to_registry_entry(
    paper: dict[str, Any],
    zotero_key: str,
    collection_name: str,
    has_pdf: bool = False,
) -> dict[str, Any]:
    """Build a registry entry from a paper dict + sync result."""
    from datetime import datetime
    return {
        "candidate_id": str(paper.get("candidate_id", "")),
        "zotero_key": zotero_key,
        "title": str(paper.get("title", ""))[:200],
        "doi": str(paper.get("doi", "")),
        "date_synced": datetime.now(UTC).isoformat(),
        "pdf_attached": has_pdf,
        "notes_synced": False,
        "zotero_collection": collection_name,
    }


def sync_papers(
    papers: list[dict[str, Any]],
    workspace_dir: Path | None = None,
    collection: str | None = None,
    db_path: Path | None = None,
    skip_existing: bool = True,
) -> list[SyncResult]:
    """Sync papers into Zotero with the best available backend.

    Priority: zotero-mcp → SQLite → CAYW.

    If *workspace_dir* is given, the collection name is derived from the
    workspace slug and the zotero_registry.jsonl is maintained.

    Each paper dict may contain:
        candidate_id, title, authors, abstract, year, venue, doi, url,
        pdf_path, pdf_sha256, provider_raw.arxiv_id
    """
    results: list[SyncResult] = []
    seen: set[str] = set()

    # Resolve collection name
    if collection:
        coll_name = collection
    elif workspace_dir:
        coll_name = _derive_collection_name(workspace_dir)
    else:
        coll_name = "Literature Review"

    # Load existing registry for dedup
    registry: list[dict[str, Any]] = []
    if workspace_dir:
        registry = load_registry(workspace_dir)
        if skip_existing:
            existing_keys = {e["candidate_id"] for e in registry if e.get("zotero_key")}
            print(f"Registry: {len(existing_keys)} papers already synced, "
                  f"will skip duplicates.\n")
        else:
            existing_keys: set[str] = set()
    else:
        existing_keys = set()

    # ── 1. zotero-mcp ──────────────────────────────────────────
    mcp = ZoteroMCPClient()
    if mcp.available():
        print(f"Backend: zotero-mcp (Zotero running, full write + PDF)\n"
              f"Collection: {coll_name}\n")
        try:
            mcp.ensure_collection(coll_name)
            for i, p in enumerate(papers):
                title = str(p.get("title", ""))[:80]
                cid = str(p.get("candidate_id", ""))

                # Skip if already in registry
                if cid and cid in existing_keys:
                    existing = find_in_registry(registry, cid)
                    zk = (existing or {}).get("zotero_key", "")
                    results.append(SyncResult(
                        i, title, "zotero_mcp", item_key=zk,
                        error="already synced (registry)",
                    ))
                    continue

                # Dedup within this batch
                dk = _dedup_key(p)
                if dk and dk in seen:
                    results.append(SyncResult(
                        i, title, "zotero_mcp", error="duplicate (skipped)",
                    ))
                    continue
                if dk:
                    seen.add(dk)

                doi = p.get("doi", "")
                pdf_path = p.get("pdf_path", "")
                pdf_ok = _validate_pdf(pdf_path, p.get("pdf_sha256"))

                try:
                    key: str | None = None
                    has_attachment = False

                    # Strategy: prefer DOI-based add (auto metadata + OA PDF cascade)
                    if doi:
                        key = mcp.add_by_doi(doi, pdf_path if pdf_ok else None, coll_name)
                        has_attachment = True

                    # Fall back to PDF import if no DOI or DOI failed
                    if not key and pdf_ok:
                        key = mcp.import_pdf(Path(pdf_path), coll_name)
                        has_attachment = True

                    # Last resort: BibTeX
                    if not key:
                        bibtex = _paper_to_bibtex(p, f"LR-{p.get('year', '?')}-{i+1:02d}")
                        key = mcp.add_by_bibtex(bibtex, coll_name)
                        has_attachment = False

                    # Ensure in collection
                    if key and coll_name:
                        mcp.add_to_collection(key, coll_name)

                    if key:
                        print(f"  ✓ {title}")
                        results.append(SyncResult(
                            i, title, "zotero_mcp",
                            item_key=key, attachment=has_attachment,
                        ))
                        # Update registry
                        if workspace_dir and cid:
                            entry = _paper_to_registry_entry(p, key, coll_name, has_attachment)
                            upsert_registry(registry, entry)
                    else:
                        results.append(SyncResult(
                            i, title, "zotero_mcp",
                            error="all add methods returned no key",
                        ))
                except ZoteroMCPError as e:
                    print(f"  ✗ {title} — {e}")
                    results.append(SyncResult(i, title, "zotero_mcp", error=str(e)))
        finally:
            mcp.close()
            # Persist registry after sync
            if workspace_dir:
                save_registry(workspace_dir, registry)
                print(f"\nRegistry updated: {registry_path(workspace_dir)} "
                      f"({len(registry)} entries)")
        return results

    # ── 2. SQLite (Zotero closed) ───────────────────────────────
    if _sqlite_available():
        print(f"Backend: SQLite (Zotero closed, full write + PDF)\n"
              f"Collection: {coll_name}\n")
        db = db_path or ZOTERO_DB
        conn = sqlite3.connect(str(db))
        try:
            coll_id = _sqlite_find_or_create_collection(conn, coll_name)
            for i, p in enumerate(papers):
                title = str(p.get("title", ""))[:80]
                cid = str(p.get("candidate_id", ""))

                if cid and cid in existing_keys:
                    existing = find_in_registry(registry, cid)
                    zk = (existing or {}).get("zotero_key", "")
                    results.append(SyncResult(
                        i, title, "sqlite", item_key=zk,
                        error="already synced (registry)",
                    ))
                    continue

                dk = _dedup_key(p)
                if dk and dk in seen:
                    results.append(SyncResult(
                        i, title, "sqlite", error="duplicate (skipped)",
                    ))
                    continue
                if dk:
                    seen.add(dk)
                pdf_path = p.get("pdf_path", "")
                pdf_ok = _validate_pdf(pdf_path, p.get("pdf_sha256"))
                try:
                    item_id, zkey = _sqlite_add_paper(
                        conn, title=p.get("title", ""),
                        authors=p.get("authors", []),
                        abstract=p.get("abstract", ""),
                        year=p.get("year"), venue=p.get("venue", ""),
                        doi=p.get("doi", ""), url=p.get("url", ""),
                        pdf_path=pdf_path if pdf_ok else None,
                    )
                    _sqlite_add_to_collection(conn, item_id, coll_id)
                    print(f"  ✓ {title}")
                    results.append(SyncResult(
                        i, title, "sqlite", item_key=zkey, attachment=pdf_ok,
                    ))
                    if workspace_dir and cid:
                        entry = _paper_to_registry_entry(p, zkey, coll_name, pdf_ok)
                        upsert_registry(registry, entry)
                except Exception as e:
                    print(f"  ✗ {title} — {e}")
                    results.append(SyncResult(i, title, "sqlite", error=str(e)))
        finally:
            conn.commit()
            conn.close()
            if workspace_dir:
                save_registry(workspace_dir, registry)
                print(f"\nRegistry updated: {registry_path(workspace_dir)} "
                      f"({len(registry)} entries)")
        return results

    # ── 3. CAYW (citation only) ─────────────────────────────────
    if _cayw_available():
        print(f"Backend: CAYW (Zotero running, citation only, no PDF)\n"
              f"Collection: {coll_name}\n")
        for i, p in enumerate(papers):
            title = str(p.get("title", ""))[:80]
            cid = str(p.get("candidate_id", ""))

            if cid and cid in existing_keys:
                existing = find_in_registry(registry, cid)
                zk = (existing or {}).get("zotero_key", "")
                results.append(SyncResult(
                    i, title, "cayw", item_key=zk,
                    error="already synced (registry)",
                ))
                continue

            dk = _dedup_key(p)
            if dk and dk in seen:
                results.append(SyncResult(
                    i, title, "cayw", error="duplicate (skipped)",
                ))
                continue
            if dk:
                seen.add(dk)
            cite_key = f"LR-{p.get('year', '?')}-{i+1:02d}"
            if _cayw_import(_paper_to_bibtex(p, cite_key)):
                print(f"  ✓ {title}")
                results.append(SyncResult(i, title, "cayw"))
            else:
                print(f"  ✗ {title}")
                results.append(SyncResult(i, title, "cayw", error="import failed"))
        print(f"\nItems in Zotero inbox. Drag to '{coll_name}' collection.\n"
              f"Note: CAYW does not support registry tracking (no Zotero key returned).")
        return results

    raise RuntimeError(
        "No Zotero backend available.\n"
        "  1. pip install zotero-mcp-server && zotero-mcp setup\n"
        "  2. Close Zotero for SQLite sync\n"
        "  3. Install Better BibTeX for CAYW import"
    )
