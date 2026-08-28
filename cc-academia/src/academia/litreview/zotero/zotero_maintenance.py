"""Zotero library maintenance: enrich bare items and mirror files locally.

Two failure modes appear when papers enter Zotero through automated paths:

1. **Bare ``document`` items.** When DOI extraction from a PDF fails (common for
   arXiv preprints), ``zotero_add_from_file`` falls back to a ``document`` item
   whose title is the filename — no authors, no date, no identifiers. Such items
   are invisible to semantic search and useless in a bibliography.

2. **Missing local files.** Attachments uploaded via the web API exist on
   zotero.org, but the desktop app shows "File Not Found" until sync pulls them
   down. Mirroring the bytes into ``~/Zotero/storage/<key>/<filename>`` makes
   them openable immediately.

Both operations use the Zotero web API via stdlib ``urllib`` — no pyzotero
dependency here (this module also runs inside the project's own venv).

Identifier strategy, in order:
  1. arXiv ID found in title / extra / attachment filename  → arXiv Atom API
  2. DOI found in the same sources                          → CrossRef
  3. otherwise                                              → CrossRef title query
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ARXIV_RE = re.compile(r"(?<![\d.])(\d{4}\.\d{4,5})(?!\d)")
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+")
ARXIV_API = "https://export.arxiv.org/api/query?id_list={}"
CROSSREF_WORKS = "https://api.crossref.org/works/{}"
CROSSREF_QUERY = "https://api.crossref.org/works?query.bibliographic={}&rows=3"
ZOTERO_API = "https://api.zotero.org"

_UA = "lit-review-zotero-maintain/1.0"


# ── pure helpers (unit-tested) ──────────────────────────────────────


def extract_arxiv_id(text: str) -> str | None:
    """Return the first new-style arXiv ID (YYMM.NNNNN) in *text*."""
    m = ARXIV_RE.search(text or "")
    return m.group(1) if m else None


def extract_doi(text: str) -> str | None:
    """Return the first DOI in *text*, stripped of trailing punctuation."""
    m = DOI_RE.search(text or "")
    if not m:
        return None
    return m.group(0).rstrip(".,;:)")


def needs_enrichment(data: dict[str, Any]) -> bool:
    """True when an item's metadata is too thin to cite or index."""
    if data.get("itemType") in ("attachment", "note", "annotation"):
        return False
    if data.get("itemType") == "document":
        return True
    title = data.get("title") or ""
    if title.lower().endswith(".pdf"):
        return True
    return bool(not data.get("creators") and not extract_doi(data.get("DOI") or ""))


def identifier_sources(item: dict[str, Any]) -> str:
    """Concatenate the text fields we mine for identifiers."""
    d = item.get("data", item)
    parts = [d.get("title") or "", d.get("extra") or "", d.get("url") or ""]
    return "\n".join(parts)


def parse_arxiv_atom(xml: str) -> dict[str, Any] | None:
    """Parse the arXiv Atom API response into a metadata dict."""
    import xml.etree.ElementTree as ET

    ns = {"a": "http://www.w3.org/2005/Atom"}
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    entry = root.find("a:entry", ns)
    if entry is None:
        return None
    id_url = (entry.findtext("a:id", default="", namespaces=ns) or "").strip()
    m = ARXIV_RE.search(id_url)
    title = " ".join((entry.findtext("a:title", default="", namespaces=ns) or "").split())
    published = (entry.findtext("a:published", default="", namespaces=ns) or "")[:10]
    authors = [
        (a.findtext("a:name", default="", namespaces=ns) or "").strip()
        for a in entry.findall("a:author", ns)
    ]
    summary = " ".join((entry.findtext("a:summary", default="", namespaces=ns) or "").split())
    if not m or not title:
        return None
    return {
        "arxiv_id": m.group(1),
        "title": title,
        "date": published,
        "authors": [a for a in authors if a],
        "abstract": summary,
        "url": f"https://arxiv.org/abs/{m.group(1)}",
    }


_NAME_PARTICLES = {"van", "von", "de", "der", "den", "di", "le", "ten", "ter", "la"}


def _split_name(name: str) -> dict[str, str]:
    """'Fedor V. Fomin' -> first 'Fedor V.' / last 'Fomin'.

    Keeps surname particles attached: 'Mark de Berg' -> first 'Mark' /
    last 'de Berg' (not lastName 'Berg', which breaks sorting and citations).
    """
    parts = name.split()
    if len(parts) >= 3 and parts[-2].lower() in _NAME_PARTICLES:
        return {"creatorType": "author",
                "firstName": " ".join(parts[:-2]),
                "lastName": f"{parts[-2]} {parts[-1]}"}
    if len(parts) >= 2:
        return {"creatorType": "author", "firstName": " ".join(parts[:-1]),
                "lastName": parts[-1]}
    return {"creatorType": "author", "firstName": "", "lastName": name}


def arxiv_to_update(meta: dict[str, Any]) -> dict[str, Any]:
    """Map parsed arXiv metadata to Zotero item fields (preprint)."""
    return {
        "itemType": "preprint",
        "title": meta["title"],
        "creators": [_split_name(a) for a in meta["authors"]],
        "date": meta["date"],
        "url": meta["url"],
        "abstractNote": meta["abstract"],
        "extra": f"arXiv: {meta['arxiv_id']}",
    }


def crossref_to_update(work: dict[str, Any]) -> dict[str, Any]:
    """Map a CrossRef work record to Zotero item fields."""
    type_map = {
        "journal-article": "journalArticle",
        "proceedings-article": "conferencePaper",
        "book-chapter": "bookSection",
        "book": "book",
        "posted-content": "preprint",
    }
    creators = [
        {
            "creatorType": "author",
            "firstName": a.get("given", ""),
            "lastName": a.get("family", ""),
        }
        for a in work.get("author", [])
        if a.get("family")
    ]
    update: dict[str, Any] = {
        "itemType": type_map.get(work.get("type", ""), "journalArticle"),
        "title": re.sub(r"<[^>]+>", "", (work.get("title") or [""])[0]),
        "creators": creators,
        "DOI": work.get("DOI", ""),
        "url": work.get("URL", ""),
        "abstractNote": re.sub(r"<[^>]+>", "", work.get("abstract", "") or ""),
    }
    container = (work.get("container-title") or [""])[0]
    if container:
        # Field name is type-specific in Zotero: journalArticle wants
        # publicationTitle, conferencePaper wants proceedingsTitle, etc.
        container_field = {
            "conferencePaper": "proceedingsTitle",
            "bookSection": "bookTitle",
            "preprint": "repository",
        }.get(update["itemType"], "publicationTitle")
        update[container_field] = container
    parts = work.get("issued", {}).get("date-parts", [[None]])[0]
    if parts and parts[0]:
        update["date"] = "-".join(str(p) for p in parts if p)
    return update


# ── web API plumbing ────────────────────────────────────────────────


def _request(
    url: str,
    api_key: str | None = None,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> tuple[int, bytes]:
    hdrs = {"User-Agent": _UA}
    if api_key:
        hdrs["Zotero-API-Key"] = api_key
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def load_dotenv(path: Path | None = None) -> None:
    """Populate os.environ from the project .env (like the MCP launcher)."""
    env_path = path or Path(__file__).resolve().parent.parent.parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _library_base(library_id: str, library_type: str) -> str:
    kind = "groups" if library_type == "group" else "users"
    return f"{ZOTERO_API}/{kind}/{library_id}"


def iter_items(
    library_id: str,
    api_key: str,
    library_type: str = "user",
    collection_key: str | None = None,
    item_type: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch all items (paged), optionally scoped to a collection/type."""
    base = _library_base(library_id, library_type)
    if collection_key:
        base += f"/collections/{collection_key}"
    params = {"limit": 100, "start": 0, "include": "data"}
    if item_type:
        params["itemType"] = item_type
    out: list[dict[str, Any]] = []
    while True:
        qs = urllib.parse.urlencode(params)
        status, raw = _request(f"{base}/items?{qs}", api_key)
        if status != 200:
            raise RuntimeError(f"Zotero API {status}: {raw[:200]!r}")
        batch = json.loads(raw)
        if not batch:
            return out
        out.extend(batch)
        if len(batch) < params["limit"]:
            return out
        params["start"] += params["limit"]


def find_collection_key(
    name: str, library_id: str, api_key: str, library_type: str = "user"
) -> str | None:
    """Resolve a collection name to its key, paging through ALL collections.

    Names are not unique in Zotero — when several match, prefer none and let
    the caller require an explicit key (workspace.toml collection_key).
    """
    base = _library_base(library_id, library_type)
    matches: list[str] = []
    start = 0
    while True:
        status, raw = _request(f"{base}/collections?limit=100&start={start}", api_key)
        if status != 200:
            return None
        batch = json.loads(raw)
        if not batch:
            break
        matches += [c["key"] for c in batch if c.get("data", {}).get("name") == name]
        if len(batch) < 100:
            break
        start += 100
    return matches[0] if len(matches) == 1 else None


def update_item(
    key: str,
    update: dict[str, Any],
    version: int,
    library_id: str,
    api_key: str,
    library_type: str = "user",
) -> tuple[bool, str]:
    """Merge *update* into the server-side item and PUT it back.

    Zotero requires the full item on PUT, so we fetch, shallow-merge the
    changed fields, and send it back version-checked. Returns (ok, detail) —
    the server's error body is preserved on failure instead of being dropped.
    """
    base = _library_base(library_id, library_type)
    status, raw = _request(f"{base}/items/{key}?include=data", api_key)
    if status != 200:
        return False, f"GET {key}: http {status}"
    item = json.loads(raw)
    data = item["data"]
    item_type = update.pop("itemType", None)
    if item_type and item_type != data.get("itemType"):
        data["itemType"] = item_type
    for field_name, value in update.items():
        if value not in (None, "", []):
            data[field_name] = value
    body = json.dumps(data).encode()
    status, raw = _request(
        f"{base}/items/{key}",
        api_key,
        method="PUT",
        body=body,
        headers={
            "Content-Type": "application/json",
            "If-Unmodified-Since-Version": str(version),
        },
    )
    return status == 204, "" if status == 204 else f"http {status}: {raw[:200]!r}"


# ── enrichment ──────────────────────────────────────────────────────


@dataclass
class EnrichResult:
    key: str
    title_before: str
    action: str  # "arxiv" | "doi" | "crossref-title" | "no-match" | "skip" | "error"
    applied: bool = False
    detail: str = ""


def fetch_arxiv_meta(arxiv_id: str) -> dict[str, Any] | None:
    status, raw = _request(ARXIV_API.format(arxiv_id))
    if status != 200:
        return None
    return parse_arxiv_atom(raw.decode("utf-8", "replace"))


def fetch_crossref_doi(doi: str) -> dict[str, Any] | None:
    status, raw = _request(CROSSREF_WORKS.format(urllib.parse.quote(doi)))
    if status != 200:
        return None
    try:
        return crossref_to_update(json.loads(raw)["message"])
    except (KeyError, json.JSONDecodeError):
        return None


def _token_overlap(a: str, b: str) -> float:
    """Jaccard overlap of lowercase word tokens (order-free)."""
    ta = {w for w in re.findall(r"[a-z0-9]+", a.lower()) if len(w) > 2}
    tb = {w for w in re.findall(r"[a-z0-9]+", b.lower()) if len(w) > 2}
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def fetch_crossref_title(title: str, min_overlap: float = 0.6) -> dict[str, Any] | None:
    """CrossRef bibliographic query, accepted only on strong title agreement.

    The blind first-hit fallback demonstrably misfires on manuals and books
    ("SimEvents User's Guide" matched "User guide to seed tracing"), so weak
    matches return None and the item is left for manual review instead.
    """
    status, raw = _request(CROSSREF_QUERY.format(urllib.parse.quote(title)))
    if status != 200:
        return None
    try:
        items = json.loads(raw)["message"]["items"]
    except (KeyError, json.JSONDecodeError):
        return None
    for work in items:
        update = crossref_to_update(work)
        if update.get("title") and _token_overlap(title, update["title"]) >= min_overlap:
            return update
    return None


def plan_update(item: dict[str, Any], fetcher: Any = None) -> tuple[str, dict[str, Any] | None]:
    """Decide how to enrich one item. Pure apart from the injected fetcher.

    *fetcher* maps (kind, value) -> update dict
    defaults to live HTTP.
    Returns (action, update_or_None).
    """
    fetch = fetcher or _live_fetcher
    text = identifier_sources(item)
    data = item.get("data", item)

    arxiv_id = extract_arxiv_id(text)
    if arxiv_id:
        update = fetch("arxiv", arxiv_id)
        if update:
            return "arxiv", update

    doi = extract_doi(data.get("DOI") or "") or extract_doi(text)
    if doi:
        update = fetch("doi", doi)
        if update:
            return "doi", update

    title = (data.get("title") or "").removesuffix(".pdf").replace("_", " ").strip()
    if len(title) > 15:
        update = fetch("crossref-title", title)
        if update:
            return "crossref-title", update

    return "no-match", None


def _live_fetcher(kind: str, value: str) -> dict[str, Any] | None:
    if kind == "arxiv":
        meta = fetch_arxiv_meta(value)
        return arxiv_to_update(meta) if meta else None
    if kind == "doi":
        return fetch_crossref_doi(value)
    return fetch_crossref_title(value)


def enrich_items(
    library_id: str,
    api_key: str,
    library_type: str = "user",
    collection_key: str | None = None,
    dry_run: bool = False,
    fetcher: Any = None,
    only_keys: set[str] | None = None,
) -> list[EnrichResult]:
    """Enrich every too-thin item in scope. Returns a per-item report.

    *only_keys* restricts enrichment to specific item keys (e.g. the workspace
    registry) — essential when the collection is shared with other projects.
    """
    results: list[EnrichResult] = []
    items = iter_items(library_id, api_key, library_type, collection_key)
    for item in items:
        if only_keys is not None and item["key"] not in only_keys:
            continue
        data = item.get("data", {})
        if not needs_enrichment(data):
            continue
        key = item["key"]
        title_before = data.get("title", "")
        try:
            action, update = plan_update(item, fetcher=fetcher)
        except Exception as e:
            # network hiccup on one item must not stop the run
            results.append(EnrichResult(key, title_before, "error", detail=str(e)))
            continue
        if not update:
            results.append(EnrichResult(key, title_before, action))
            continue
        applied = False
        fail_detail = ""
        if not dry_run:
            applied, fail_detail = update_item(
                key, dict(update), item.get("version", 0),
                library_id, api_key, library_type,
            )
        results.append(
            EnrichResult(key, title_before, action, applied=applied or dry_run,
                         detail=update.get("title", "") if (applied or dry_run) else fail_detail)
        )
    return results


# ── local storage mirroring ─────────────────────────────────────────


def default_storage_dir() -> Path:
    return Path.home() / "Zotero" / "storage"


@dataclass
class MirrorResult:
    key: str
    filename: str
    status: str  # "downloaded" | "present" | "no-file" | "error"
    detail: str = ""


def mirror_attachments(
    library_id: str,
    api_key: str,
    library_type: str = "user",
    collection_key: str | None = None,
    storage_dir: Path | None = None,
    dry_run: bool = False,
    only_keys: set[str] | None = None,
) -> list[MirrorResult]:
    """Ensure every uploaded attachment exists in the local storage directory.

    *only_keys* restricts mirroring to attachments whose parentItem is in the
    set (e.g. the workspace registry) — important in shared collections.
    Downloaded bytes are md5-verified against the server record when an md5
    is available
    any 200 with a non-empty body is accepted (attachments are
    not only PDFs: HTML snapshots, text, images).
    """
    root = storage_dir or default_storage_dir()
    base = _library_base(library_id, library_type)
    results: list[MirrorResult] = []

    attachments = iter_items(library_id, api_key, library_type, collection_key,
                             item_type="attachment")
    for att in attachments:
        data = att.get("data", {})
        key = att["key"]
        filename = data.get("filename") or ""
        if data.get("linkMode") not in ("imported_file", "imported_url") or not filename:
            continue
        if only_keys is not None and data.get("parentItem") not in only_keys:
            continue
        if not data.get("md5"):
            # never uploaded — nothing to mirror
            results.append(MirrorResult(key, filename, "no-file"))
            continue
        dest = root / key / filename
        if dest.exists() and dest.stat().st_size > 0:
            results.append(MirrorResult(key, filename, "present"))
            continue
        if dry_run:
            results.append(MirrorResult(key, filename, "downloaded", "dry-run"))
            continue
        status, raw = _request(f"{base}/items/{key}/file", api_key, timeout=300)
        if status != 200 or not raw:
            results.append(MirrorResult(key, filename, "error", f"http {status}"))
            continue
        expected_md5 = (data.get("md5") or "").lower()
        if expected_md5:
            got_md5 = hashlib.md5(raw).hexdigest()
            if got_md5 != expected_md5:
                results.append(MirrorResult(key, filename, "error",
                                            f"md5 mismatch {got_md5} != {expected_md5}"))
                continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        results.append(MirrorResult(key, filename, "downloaded"))
    return results
