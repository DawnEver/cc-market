"""Batch-import workspace PDFs into Zotero, DOI-deduped, with registry upkeep.

Design agreement (2026-07-27): ALL papers live in one shared Zotero collection
(e.g. ``Engineering``)
each workspace keeps its own catalogue and index in
``zotero_registry.jsonl`` (candidate/file ↔ zotero_key) plus a workspace tag on
every imported item. This module is the write path of that agreement.

Identity ladder for dedupe:
  1. DOI extracted from the PDF (metadata fields, then first-page text)
  2. normalised filename stem (falls back for identifier-less PDFs)

The same paper often sits in several workspace directories under different
filenames (``papers/`` vs ``pdfs/``)
grouping by DOI collapses them and one
canonical file is uploaded (priority: ``download/pdfs`` > ``papers`` > ``pdfs``).

Uses pyzotero (present in the shared venv via zotero-mcp-server) plus the
attachment patch from ``scripts/zotero_mcp_patch.py`` so uploads actually land.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from academia.litreview.zotero import zotero_maintenance as zm
from academia.litreview.zotero.zotero import load_registry, save_registry, upsert_registry

PDF_DIRS = ("download/pdfs", "papers", "pdfs")  # priority order; ingest/ excluded

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


# ── pure helpers (unit-tested) ──────────────────────────────────────


_AUTHOR_YEAR = re.compile(r"^[a-z]+\d{4}")


def normalize_stem(filename: str) -> str:
    """Lowercase alphanumeric-only stem: 'CutCount_FOCS2011_1103.0534.pdf' -> 'cutcountfocs201111030534'."""
    stem = Path(filename).stem.lower()
    return _NON_ALNUM.sub("", stem)


def _candidate_matches(stem: str, candidate_ids: set[str]) -> bool:
    """True when a PDF filename stem belongs to one of the candidate ids.

    PDF filenames are ``<candidate_id-truncated-to-40>_<title>.pdf`` (safe_filename
    truncates the id part). Match on the id token only, in either direction, so a
    full candidate id matches its truncated filename and vice versa.
    """
    file_id = stem.split("_", 1)[0]
    return any(w.startswith(file_id) or file_id.startswith(w) for w in candidate_ids)


def title_key(filename: str) -> str:
    """Normalised stem minus a leading author-year token, so that
    'moggwalls2024_Automatic_Routing...' and 'moggwalls2024_Development_of_...'
    both reduce to the title part and substring matching can recognise them
    as the same work. Falls back to the full stem when stripping would leave
    too little to be distinctive ('AllSAT_TACAS2005' -> 'allsattacas2005')."""
    full = normalize_stem(filename)
    stripped = _AUTHOR_YEAR.sub("", full, count=1)
    return stripped if len(stripped) >= 20 else full


def extract_doi_from_pdf(path: Path) -> str | None:
    """Extract a DOI from PDF metadata or first-page text. None if unavailable."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None
    try:
        with fitz.open(path) as doc:
            meta = doc.metadata or {}
            for field in ("subject", "keywords", "title"):
                doi = zm.extract_doi(meta.get(field, "") or "")
                if doi:
                    return doi
            if doc.page_count > 0:
                return zm.extract_doi(doc[0].get_text()[:3000])
    except Exception:
        return None
    return None


def iter_workspace_pdfs(workspace_dir: Path) -> list[tuple[Path, int]]:
    """All PDFs under the canonical dirs, each with its priority (lower = better)."""
    found: list[tuple[Path, int]] = []
    for prio, rel in enumerate(PDF_DIRS):
        d = workspace_dir / rel
        if d.is_dir():
            found.extend((p, prio) for p in sorted(d.glob("*.pdf")))
    return found


@dataclass
class PdfGroup:
    key: str  # 'doi:...' or 'fn:<normstem>'
    canonical: Path
    duplicates: list[Path]
    doi: str | None


def group_pdfs(files: list[tuple[Path, int]], doi_of: Any = None) -> list[PdfGroup]:
    """Group (path, priority) pairs by DOI/identity, picking a canonical file.

    *doi_of* overrides DOI extraction (tests inject a fake).
    """
    get_doi = doi_of or extract_doi_from_pdf
    buckets: dict[str, list[tuple[Path, int]]] = {}
    doi_by_key: dict[str, str | None] = {}
    for path, prio in files:
        doi = get_doi(path)
        key = f"doi:{doi.lower()}" if doi else f"fn:{normalize_stem(path.name)}"
        doi_by_key[key] = doi
        buckets.setdefault(key, []).append((path, prio))
    groups: list[PdfGroup] = []
    for key, members in buckets.items():
        members.sort(key=lambda m: (m[1], len(m[0].name)))
        groups.append(
            PdfGroup(
                key=key,
                canonical=members[0][0],
                duplicates=[p for p, _ in members[1:]],
                doi=doi_by_key[key],
            )
        )
    # Second pass: a DOI-less group whose canonical title_key matches a DOI
    # group's is the same paper whose identifier extraction failed — merge it
    # in rather than import it twice (e.g. two england2021 scans).
    by_stem: dict[str, PdfGroup] = {}
    merged: list[PdfGroup] = []
    for g in sorted(groups, key=lambda g:
        g.doi is None):  # DOI groups first
        stem = title_key(g.canonical.name)
        primary = by_stem.get(stem)
        if primary is None or (primary.doi and g.doi):
            by_stem.setdefault(stem, g)
            merged.append(g)
        else:
            primary.duplicates.append(g.canonical)
            primary.duplicates.extend(g.duplicates)
    # Third pass: same paper scanned under structurally different filenames
    # ("moggwalls2024_Automatic_Routing..." vs "...Development_of_...Routing...")
    # — one title_key is a substring of the other. Guards: never merge two
    # DOI-bearing groups (distinct identifiers = distinct papers), and both
    # filenames must carry the SAME author-year prefix (substring alone can
    # over-merge "smith2023_Attention" with "smith2023_Attention_Survey").
    final: list[PdfGroup] = []
    for g in merged:
        stem = title_key(g.canonical.name)
        target = None
        for other in final:
            if g.doi and other.doi:
                continue
            if _author_year(g.canonical.name) != _author_year(other.canonical.name):
                continue
            ostem = title_key(other.canonical.name)
            shorter, longer = (stem, ostem) if len(stem) <= len(ostem) else (ostem, stem)
            if len(shorter) >= 20 and shorter in longer:
                target = other
                break
        if target is None:
            final.append(g)
        else:
            target.duplicates.extend([g.canonical, *g.duplicates])
            if not target.doi and g.doi:
                target.doi, target.key = g.doi, g.key
    return final


def _author_year(filename: str) -> str | None:
    """Leading authorYYYY token of the normalised stem, e.g. 'moggwalls2024'."""
    m = _AUTHOR_YEAR.match(normalize_stem(filename))
    return m.group(0) if m else None


def build_item_template(zot: Any, group: PdfGroup) -> dict[str, Any]:
    """Create the Zotero item template for a group (CrossRef-enriched when DOIed)."""
    if group.doi:
        update = zm.fetch_crossref_doi(group.doi)
        if update:
            item_type = update.pop("itemType")
            tmpl = zot.item_template(item_type)
            for field_name, value in update.items():
                if value not in (None, "", []):
                    tmpl[field_name] = value
            return tmpl
    tmpl = zot.item_template("document")
    tmpl["title"] = group.canonical.stem
    return tmpl


# ── import ──────────────────────────────────────────────────────────


@dataclass
class ImportResult:
    candidate_id: str
    canonical: str
    action: str  # "created" | "reused" | "skipped-registry" | "error"
    zotero_key: str = ""
    pdf_attached: bool = False
    duplicates: int = 0
    detail: str = ""


def _load_pyzotero(library_id: str, api_key: str, library_type: str) -> Any:
    # Load the attachment patch from scripts/ by file path (no sys.path
    # mutation — the module is importable under exactly one name).
    import importlib.util

    patch_path = Path(__file__).resolve().parent.parent.parent / "scripts" / "zotero_mcp_patch.py"
    spec = importlib.util.spec_from_file_location("zotero_mcp_patch", patch_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.apply()

    from pyzotero import zotero

    return zotero.Zotero(library_id, library_type, api_key)


def _find_item_by_doi(zot: Any, doi: str) -> dict[str, Any] | None:
    # Lookup failures (auth, rate-limit, network) must NOT silently fall
    # through to create_items — the caller's per-group handler records them
    # as 'error' instead of manufacturing duplicates.
    for item in zot.items(q=doi):
        if (item.get("data", {}).get("DOI") or "").lower() == doi.lower():
            return item
    return None


def _attach_pdf(zot: Any, parent_key: str, pdf: Path) -> bool:
    """Attach pdf to parent; skip when same-filename attachment already exists."""
    try:
        children = zot.children(parent_key)
    except Exception:
        children = []
    if any((c.get("data", {}) or {}).get("filename") == pdf.name for c in children):
        return True
    zot.attachment_both([(pdf.name, str(pdf))], parentid=parent_key)
    return True


def _ensure_collections_and_tags(
    zot: Any, item: dict[str, Any], collection_key: str | None, tags: list[str]
) -> None:
    data = item["data"]
    changed = False
    colls = data.get("collections") or []
    if collection_key and collection_key not in colls:
        data["collections"] = [*colls, collection_key]
        changed = True
    have = {t.get("tag") for t in data.get("tags") or []}
    missing = [t for t in tags if t not in have]
    if missing:
        data["tags"] = (data.get("tags") or []) + [{"tag": t} for t in missing]
        changed = True
    if changed:
        zot.update_item(item)


def import_workspace_pdfs(
    workspace_dir: Path,
    library_id: str,
    api_key: str,
    library_type: str = "user",
    collection_key: str | None = None,
    tags: list[str] | None = None,
    dry_run: bool = False,
    force: bool = False,
    zot: Any = None,
    candidate_ids: list[str] | None = None,
) -> list[ImportResult]:
    """Import workspace PDFs into Zotero and maintain the registry.

    When *candidate_ids* is given, only PDFs whose canonical stem starts with one
    of those candidate ids are imported (the stem is the PDF filename, which the
    acquisition pipeline names `<candidate_id>_<title>.pdf`). Otherwise every
    workspace PDF is imported.
    """
    tags = tags or []
    files = iter_workspace_pdfs(workspace_dir)
    groups = group_pdfs(files)
    if candidate_ids:
        wanted = {c.strip() for c in candidate_ids if c and c.strip()}
        groups = [g for g in groups if _candidate_matches(g.canonical.stem, wanted)]
        if not groups:
            print(f"warning: no workspace PDF matches candidate_ids={sorted(wanted)}",
                  file=sys.stderr)

    if dry_run:
        return [
            ImportResult(
                candidate_id=g.canonical.stem,
                canonical=str(g.canonical.relative_to(workspace_dir)),
                action="dry-run",
                duplicates=len(g.duplicates),
                detail=g.key,
            )
            for g in groups
        ]

    zot = zot or _load_pyzotero(library_id, api_key, library_type)
    registry = load_registry(workspace_dir)
    results: list[ImportResult] = []

    try:
        for g in groups:
            cid = g.canonical.stem
            rel = str(g.canonical.relative_to(workspace_dir))
            existing = {e.get("candidate_id"): e for e in registry}.get(cid)
            if existing and not force:
                results.append(ImportResult(cid, rel, "skipped-registry",
                                            zotero_key=existing.get("zotero_key", ""),
                                            pdf_attached=bool(existing.get("pdf_attached"))))
                continue
            try:
                item = _find_item_by_doi(zot, g.doi) if g.doi else None
                if item:
                    key = item["key"]
                    action = "reused"
                    _ensure_collections_and_tags(zot, item, collection_key, tags)
                else:
                    tmpl = build_item_template(zot, g)
                    if collection_key:
                        tmpl["collections"] = [collection_key]
                    if tags:
                        tmpl["tags"] = [{"tag": t} for t in tags]
                    created = zot.create_items([tmpl])
                    if not created.get("success"):
                        raise RuntimeError(f"create_items rejected: {created.get('failed')}")
                    key = next(iter(created["success"].values()))
                    action = "created"

                pdf_ok = _attach_pdf(zot, key, g.canonical)

                entry = {
                    "candidate_id": cid,
                    "zotero_key": key,
                    "title": g.canonical.stem,
                    "doi": g.doi or "",
                    "date_synced": datetime.now(UTC).isoformat(),
                    "pdf_attached": pdf_ok,
                    "notes_synced": False,
                    "zotero_collection": collection_key or "",
                    "source_path": rel,
                    "alternate_paths": [str(p.relative_to(workspace_dir)) for p in g.duplicates],
                    "tags": tags,
                }
                registry = upsert_registry(registry, entry)
                results.append(ImportResult(cid, rel, action, zotero_key=key,
                                            pdf_attached=pdf_ok,
                                            duplicates=len(g.duplicates)))
            except Exception as e:
                results.append(ImportResult(cid, rel, "error", detail=str(e)[:200]))
    finally:
        # One full-file write per run, even on crash — entries already upserted
        # above are preserved.
        if not dry_run:
            save_registry(workspace_dir, registry)
    return results
