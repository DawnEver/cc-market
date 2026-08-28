"""PDF decomposition — drives paper_pdf_ingest against a confirmed manifest."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from academia.litreview.acquire_pipeline import sha256_file, validate_pdf
from academia.litreview.schema import require_keys

ARTIFACT_VERSION = 1


def _safe_component(value: str, fallback: str) -> str:
    component = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return component[:80] or fallback


def ingest_output_dir(topic_dir: Path, candidate_id: str) -> Path:
    """Canonical decomposition output directory for a candidate.

    Single source of truth for the slug so cache checks and readers agree
    with what :func:`decompose_pdfs` actually writes (case-folded slug).

    When the canonical CID-based directory does not exist but an older
    title-slug directory contains a paper.md, that directory is returned
    instead — this provides backward compatibility with ingestions from
    before the CID-based naming convention was standardized.
    """
    canonical = topic_dir / "ingest" / _safe_component(str(candidate_id), "paper")
    if canonical.exists():
        return canonical

    # Backward-compat: check the repair-built compat_map.json for old-style
    # title-based directories, then fall back to content scanning.
    ingest_root = topic_dir / "ingest"
    if not ingest_root.exists():
        return canonical

    # 1. Check compat_map.json (written by lit-review repair)
    mapping_path = ingest_root / "compat_map.json"
    if mapping_path.exists():
        try:
            compat_map = json.loads(mapping_path.read_text(encoding="utf-8"))
            old_name = compat_map.get(canonical.name)
            if old_name:
                compat_dir = ingest_root / old_name
                if compat_dir.is_dir() and (compat_dir / "1-paper-text" / "paper.md").exists():
                    return compat_dir
        except (json.JSONDecodeError, OSError):
            pass

    # 2. Content-based fallback: word-boundary CID match in paper.md
    cid_lower = str(candidate_id).lower()
    cid_pattern = re.compile(rf"(?:^|[^a-z0-9]){re.escape(cid_lower)}(?:[^a-z0-9]|$)")
    for d in ingest_root.iterdir():
        if not d.is_dir() or d.name == canonical.name:
            continue
        paper_md = d / "1-paper-text" / "paper.md"
        if not paper_md.exists():
            continue
        try:
            content = paper_md.read_text(encoding="utf-8")[:8192]
            if cid_pattern.search(content.lower()):
                return d
        except (OSError, UnicodeDecodeError):
            continue

    return canonical


def _validate_ingest_output(output_dir: Path) -> None:
    required = [
        output_dir / "0-raw.pdf",
        output_dir / "1-paper-text" / "paper.md",
        output_dir / "1-paper-text" / "INDEX.md",
    ]
    missing = [str(p) for p in required if not p.is_file()]
    section_dir = output_dir / "1-paper-text" / "md"
    if not section_dir.is_dir() or not any(section_dir.glob("*.md")):
        missing.append(str(section_dir / "*.md"))
    if missing:
        raise ValueError("ingest output is incomplete: " + ", ".join(missing))


def _write_manifest_atomic(path: Path, artifact: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(artifact, f, indent=2, ensure_ascii=True)
            f.write("\n")
    except BaseException:
        os.unlink(tmp)
        raise
    os.replace(tmp, path)


def _ingest_one(pdf_path: Path, out_dir: Path) -> None:
    """Run paper_pdf_ingest on a single PDF using its public Python API."""
    from paper_pdf_ingest import (
        clean_sections,
        convert,
        split_sections,
        write_paper_output,
    )
    from paper_pdf_ingest.convert import augment_markdown_with_formulas
    from paper_pdf_ingest.utils import slug

    raw_dest = out_dir / "0-raw.pdf"
    if pdf_path != raw_dest:
        shutil.copy2(pdf_path, raw_dest)

    text_dir = out_dir / "1-paper-text"
    (text_dir / "img" / "flat").mkdir(parents=True, exist_ok=True)

    md_text, _tool = convert(pdf_path, text_dir)
    md_text = augment_markdown_with_formulas(md_text, pdf_path)

    raw_sections = split_sections(md_text)
    main_sections, appended_papers = clean_sections(raw_sections)

    if not main_sections:
        raise RuntimeError("no sections found in PDF")

    write_paper_output(main_sections, text_dir, md_text, pdf_path=pdf_path)

    appended_dir = text_dir / "appended"
    if appended_dir.exists():
        shutil.rmtree(appended_dir, ignore_errors=True)
    if appended_papers:
        appended_dir.mkdir(parents=True, exist_ok=True)
        for i, (title, ap_sections) in enumerate(appended_papers, 1):
            ap_dir = appended_dir / f"{i:02d}-{slug(title) or f'paper-{i}'}"
            ap_dir.mkdir(parents=True, exist_ok=True)
            ap_img = ap_dir / "img" / "flat"
            ap_img.mkdir(parents=True, exist_ok=True)
            src_flat = text_dir / "img" / "flat"
            if src_flat.exists():
                for img in src_flat.iterdir():
                    if img.is_file():
                        shutil.copy2(img, ap_img / img.name)
            write_paper_output(ap_sections, ap_dir,
                               ap_sections[0][1] if ap_sections else "",
                               title_override=title, pdf_path=pdf_path)

    shutil.rmtree(text_dir / "_marker_tmp", ignore_errors=True)
    shutil.rmtree(text_dir / "img" / "flat", ignore_errors=True)


def decompose_pdfs(
    manifest_path: Path,
    run_dir: Path,
    confirmed_by_user: bool,
    candidate_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Decompose validated PDFs only after explicit user confirmation.

    When *candidate_ids* is given, only those papers are processed.
    """
    if not confirmed_by_user:
        raise ValueError("PDF decomposition requires explicit user confirmation")

    manifest_path = manifest_path.expanduser().resolve()
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)

    # Validate manifest has required shape
    manifest_errors = require_keys(manifest, "papers", "manifest_id")
    if manifest_errors:
        raise ValueError(f"invalid manifest — missing: {manifest_errors}")

    run_dir = run_dir.expanduser().resolve()
    ingest_root = run_dir / "ingest"
    ingest_root.mkdir(parents=True, exist_ok=True)

    ingests: list[dict[str, Any]] = []
    all_ids = [str(p["candidate_id"]) for p in manifest["papers"]]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("download manifest contains duplicate candidate_id values")

    papers = manifest["papers"]
    if candidate_ids is not None:
        wanted = {str(c) for c in candidate_ids}
        papers = [p for p in papers if str(p["candidate_id"]) in wanted]

    used: set[str] = set()
    for paper in papers:
        cid = str(paper["candidate_id"])
        slug_name = _safe_component(cid, "paper")
        if slug_name in used:
            slug_name = f"{slug_name}-{hashlib.sha256(cid.encode()).hexdigest()[:8]}"
        used.add(slug_name)
        output_dir = ingest_root / slug_name

        record: dict[str, Any] = {
            "candidate_id": cid, "pdf_path": str(paper["pdf_path"]),
            "output_path": str(output_dir), "status": "failed",
        }

        if output_dir.exists():
            record.update(status="skipped", error="output directory already exists")
            ingests.append(record)
            continue

        temp_dir: Path | None = None
        try:
            pdf_path = Path(str(paper["pdf_path"])).expanduser().resolve()
            record["pdf_path"] = str(pdf_path)
            temp_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}-", dir=ingest_root))
            staged = temp_dir / ".source.pdf"
            shutil.copy2(pdf_path, staged)
            validate_pdf(staged)
            if sha256_file(staged) != str(paper["sha256"]):
                raise ValueError(f"PDF SHA-256 changed: {pdf_path}")

            _ingest_one(staged, temp_dir)
            staged.unlink()
            _validate_ingest_output(temp_dir)
            temp_dir.rename(output_dir)
            temp_dir = None
            record["status"] = "succeeded"
        except Exception as exc:
            record["error"] = str(exc)[-2000:]
        finally:
            if temp_dir is not None:
                shutil.rmtree(temp_dir, ignore_errors=True)
        ingests.append(record)

    artifact = {
        "artifact_version": ARTIFACT_VERSION,
        "manifest_type": "ingest_manifest",
        "generated_at": datetime.now(UTC).isoformat(),
        "source_manifest": str(manifest_path),
        "source_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "confirmed_by_user": True,
        "ingests": ingests,
    }
    # Self-validate: manifest must have ingests list
    if "ingests" not in artifact:
        raise ValueError("invalid ingest manifest: missing 'ingests'")
    _write_manifest_atomic(ingest_root / "ingest_manifest.json", artifact)

    for item in ingests:
        print(f"{item['candidate_id']}: {item['status']}; output={item['output_path']}")
        if item.get("error"):
            print(f"  error: {item['error']}")
    succeeded = sum(1 for i in ingests if i["status"] == "succeeded")
    failed = sum(1 for i in ingests if i["status"] == "failed")
    skipped = sum(1 for i in ingests if i["status"] == "skipped")
    print(f"succeeded={succeeded}; failed={failed}; skipped={skipped}")
    return artifact
