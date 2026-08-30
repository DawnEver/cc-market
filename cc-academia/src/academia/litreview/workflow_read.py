"""Deep reading: one paper at a time, through a domain lens, into a paper card."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from academia.litreview.cards import load_cards

if TYPE_CHECKING:
    pass


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

# 4. Deep read (wires orphaned review_paper)
# ---------------------------------------------------------------------------

def run_read(
    topic_dir: Path,
    candidate_id: str,
    *,
    lens: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Deep-read a single paper and produce a PaperCard.

    Args:
        topic_dir: Path to ongoing/<slug>/
        candidate_id: Which paper to read
        lens: Optional domain lens name (e.g. 'power_electronics')
        model: Optional model override

    Returns:
        PaperCard as dict
    """
    # Load the decomposed paper text (canonical slugged dir)
    from academia.litreview.ingest_pipeline import ingest_output_dir
    from academia.litreview.models import ResearchBrief
    from academia.litreview.reader import review_paper
    from academia.litreview.schema import load_data
    ingest_dir = ingest_output_dir(topic_dir, candidate_id)
    paper_md = ingest_dir / "1-paper-text" / "paper.md"
    if not paper_md.exists():
        raise FileNotFoundError(f"Paper not decomposed: {paper_md}. Run ingest step first.")

    paper_text = paper_md.read_text(encoding="utf-8")
    # Also collect per-section markdown
    md_dir = ingest_dir / "1-paper-text" / "md"
    if md_dir.exists():
        sections = sorted(md_dir.glob("*.md"))
        for sec in sections:
            paper_text += "\n\n" + sec.read_text(encoding="utf-8")

    # Load brief for criteria context
    brief_path = topic_dir / "research_brief.toml"
    brief_data = load_data(brief_path) if brief_path.exists() else {}
    brief = ResearchBrief.from_dict({"brief_id": "", "original_request": "",
                                     "research_objective": "", **brief_data})

    # Load lens if specified
    lens_data: dict[str, Any] | None = None
    if lens:
        from academia.core.paths import lens_file

        # Plugin defaults first, the user's override directory in front of them.
        lens_path = lens_file(lens)
        if lens_path.exists():
            lens_data = load_data(lens_path)

    # If lens provides context, prepend to paper text
    if lens_data:
        checklist = lens_data.get("technical_checklist", [])
        red_flags = lens_data.get("red_flags", [])
        if checklist or red_flags:
            lens_context = "\n\n## Domain Lens Context\n"
            if checklist:
                lens_context += "\n### Technical Checklist\n"
                for item in checklist:
                    lens_context += f"- [{item.get('category', '')}] {item.get('item', '')}\n"
            if red_flags:
                lens_context += "\n### Red Flags to Watch For\n"
                for rf in red_flags:
                    lens_context += f"- [{rf.get('severity', 'warning')}] {rf.get('flag', '')}: {rf.get('explanation', '')}\n"
            paper_text = lens_context + paper_text

    # Deep read
    card = review_paper(
        paper_text=paper_text,
        brief=brief,
        model_spec=model,
        candidate_id=candidate_id,
        title="",  # Will be extracted from paper.md
    )

    # Write output
    reading_dir = _ensure(topic_dir / "reading")
    card_dict: dict[str, Any] = card.to_dict()
    card_path = reading_dir / f"{candidate_id}_card.json"
    card_path.write_text(json.dumps(card_dict, indent=2, ensure_ascii=True, default=str), encoding="utf-8")

    # Render markdown
    from academia.litreview.render import paper_card_to_markdown
    md = paper_card_to_markdown(card)
    (reading_dir / f"{candidate_id}_card.md").write_text(md, encoding="utf-8")

    return card_dict


# ---------------------------------------------------------------------------
# 5. Cross-paper synthesis (wires orphaned compare_papers)
# ---------------------------------------------------------------------------

def run_synthesize(
    topic_dir: Path,
    *,
    paper_ids: list[str] | None = None,
    model: str | None = None,
) -> str:
    """Synthesize findings across deep-read papers.

    Args:
        topic_dir: Path to ongoing/<slug>/
        paper_ids: Specific paper candidate IDs. None = all with cards.
        model: Optional model override

    Returns:
        Synthesis text (markdown)
    """
    from academia.litreview.synthesis import compare_papers

    cards = load_cards(topic_dir, paper_ids)
    if not cards:
        raise ValueError("No paper cards found. Deep-read some papers first.")

    synthesis = compare_papers(cards, model_spec=model)

    # Write output
    notes_dir = _ensure(topic_dir / "notes")
    (notes_dir / "synthesis.md").write_text(synthesis, encoding="utf-8")

    return synthesis


# ---------------------------------------------------------------------------
# 6. Export & stats (wires orphaned render + plot)
# ---------------------------------------------------------------------------
