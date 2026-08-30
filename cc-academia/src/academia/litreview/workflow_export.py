"""Export and statistics: cards -> markdown, CSV, BibTeX and plots."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from academia.litreview.cards import load_cards

if TYPE_CHECKING:
    pass

#: Characters BibTeX treats as markup and that a title may legitimately contain.
_BIBTEX_SPECIALS = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_"}


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> Path:
    _ensure(path.parent)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")
    return path


# ---------------------------------------------------------------------------
# 1. Search pipeline
# ---------------------------------------------------------------------------

# 6. Export & stats (wires orphaned render + plot)
# ---------------------------------------------------------------------------



def _bibtex_escape(value: Any) -> str:
    text = str(value or "")
    text = text.replace("\\", r"\textbackslash{}")
    for char, repl in _BIBTEX_SPECIALS.items():
        text = text.replace(char, repl)
    return text


def _candidate_metadata(topic_dir: Path) -> dict[str, dict[str, Any]]:
    """Index ranked candidates by candidate_id (including merged aliases)."""
    meta: dict[str, dict[str, Any]] = {}
    for row in _read_jsonl(topic_dir / "search" / "candidates_ranked.jsonl"):
        for cid in {str(row.get("candidate_id", "")), *map(str, row.get("merged_candidate_ids", []))}:
            if cid:
                meta.setdefault(cid, row)
    return meta


def _bibtex_entry(card: Any, meta: dict[str, Any]) -> str:
    is_journal = "journal" in str(meta.get("content_type", "")).lower() or not meta.get("content_type")
    entry_type = "article" if is_journal else "inproceedings"
    venue_field = "journal" if is_journal else "booktitle"

    key = _re_bib_key(card.candidate_id)
    fields: list[tuple[str, Any]] = [
        ("title", card.title or meta.get("title", "")),
        ("author", " and ".join(meta.get("authors", []))),
        ("year", meta.get("publication_year", "")),
        (venue_field, meta.get("venue", "")),
        ("doi", meta.get("doi", "")),
        ("note", card.one_sentence),
    ]
    lines = [f"@{entry_type}{{{key},"]
    for name, value in fields:
        if value:
            # DOIs must stay verbatim (underscores are legal there)
            rendered = str(value) if name == "doi" else _bibtex_escape(value)
            lines.append(f"  {name} = {{{rendered}}},")
    lines.append("}")
    return "\n".join(lines)


def _re_bib_key(candidate_id: str) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9:_-]+", "-", str(candidate_id)).strip("-") or "paper"

def run_export(
    topic_dir: Path,
    *,
    format: str = "markdown",  # markdown | csv | bibtex | json
    paper_ids: list[str] | None = None,
) -> Path:
    """Export paper cards in the requested format.

    Args:
        topic_dir: Path to ongoing/<slug>/
        format: Output format
        paper_ids: Specific papers. None = all cards.

    Returns:
        Path to exported file
    """
    from academia.litreview.render import cards_to_csv

    cards = load_cards(topic_dir, paper_ids)
    export_dir = _ensure(topic_dir / "export")

    if format == "csv":
        out = export_dir / "papers.csv"
        cards_to_csv(cards, out)
    elif format == "json":
        out = export_dir / "papers.json"
        out.write_text(json.dumps([c.to_dict() for c in cards], indent=2, ensure_ascii=True, default=str), encoding="utf-8")
    elif format == "bibtex":
        out = export_dir / "references.bib"
        meta = _candidate_metadata(topic_dir)
        entries = [_bibtex_entry(card, meta.get(card.candidate_id, {})) for card in cards]
        out.write_text("\n\n".join(entries) + "\n", encoding="utf-8")
    else:
        # markdown
        from academia.litreview.render import paper_card_to_markdown
        out = export_dir / "papers.md"
        parts = [paper_card_to_markdown(c) for c in cards]
        out.write_text("\n\n---\n\n".join(parts), encoding="utf-8")

    return out


def run_stats(
    topic_dir: Path,
    *,
    plots: bool = False,
) -> dict[str, Any]:
    """Generate summary statistics for the review.

    Args:
        topic_dir: Path to ongoing/<slug>/
        plots: If True, generate matplotlib plots

    Returns:
        Stats dict
    """
    stats: dict[str, Any] = {}

    # Search stats
    ranked_path = topic_dir / "search" / "candidates_ranked.jsonl"
    if ranked_path.exists():
        candidates = _read_jsonl(ranked_path)
        stats["total_candidates"] = len(candidates)
        years_raw = [c.get("publication_year") for c in candidates]
        years = [int(y) for y in years_raw if y is not None]
        if years:
            stats["year_range"] = f"{min(years)}-{max(years)}"
        venues = set(c.get("venue", "") for c in candidates if c.get("venue"))
        stats["unique_venues"] = len(venues)

    # Screening stats
    screening_path = topic_dir / "screening" / "screening_stage1.jsonl"
    if screening_path.exists():
        screened = _read_jsonl(screening_path)
        decisions = {}
        for s in screened:
            d = s.get("decision", "unknown")
            decisions[d] = decisions.get(d, 0) + 1
        stats["screening"] = decisions

    # Download stats
    manifest_path = topic_dir / "handoff" / "download_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        stats["downloaded"] = len(manifest.get("papers", []))

    # Ingest stats
    ingest_manifest = topic_dir / "ingest" / "ingest_manifest.json"
    if ingest_manifest.exists():
        im = json.loads(ingest_manifest.read_text(encoding="utf-8"))
        stats["decomposed"] = sum(1 for i in im.get("ingests", []) if i["status"] == "succeeded")

    # Reading stats
    reading_dir = topic_dir / "reading"
    if reading_dir.exists():
        stats["deep_read"] = len(list(reading_dir.glob("*_card.json")))

    # Write stats
    stats_path = topic_dir / "notes" / "stats.json"
    _ensure(topic_dir / "notes")
    stats_path.write_text(json.dumps(stats, indent=2, ensure_ascii=True), encoding="utf-8")

    # Plots
    if plots and ranked_path.exists():
        try:
            from academia.litreview.models import Candidate
            from academia.litreview.plot import plot_venue_distribution, plot_year_distribution
            candidates = []
            skipped_rows = 0
            for c in _read_jsonl(ranked_path):
                try:
                    candidates.append(Candidate.from_dict(c))
                except (ValueError, TypeError):
                    skipped_rows += 1
            if skipped_rows:
                stats["plot_rows_skipped"] = skipped_rows
            plot_dir = _ensure(topic_dir / "export" / "plots")
            plot_year_distribution(candidates, plot_dir / "year_distribution.png")
            plot_venue_distribution(candidates, plot_dir / "venue_distribution.png")
            stats["plots"] = str(plot_dir)
        except Exception as exc:
            stats["plot_error"] = str(exc)

    return stats
