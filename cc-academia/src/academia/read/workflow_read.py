"""Deep reading: one paper at a time, through a domain lens, into a paper card."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from academia.read.cards import load_cards

if TYPE_CHECKING:
    pass


def output_language(topic_dir: Path) -> str:
    """The workspace's ``[output] language`` (BCP 47 tag); ``"en"`` when unset."""
    from academia.read.schema import load_data

    ws_path = topic_dir / "workspace.toml"
    ws = load_data(ws_path) if ws_path.exists() else {}
    return str((ws.get("output") or {}).get("language") or "en")


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> Path:
    _ensure(path.parent)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")
    return path


def lens_context(lens_path: Path, lens_data: dict[str, Any]) -> str:
    """Domain-lens context prepended to a paper: the review criteria of the lens's field
    (``knowledge/fields/<field>/<content>/criteria.tsv``, applies peer or both) and the
    ``technical_checklist`` / ``red_flags`` tables of a user override lens (``ACADEMIA_LENS_DIR``)."""
    from academia.core.paths import knowledge_dir

    lines: list[str] = []
    fields = knowledge_dir() / "fields"
    if lens_path.parent.parent == fields:
        from academia.knowledge.resolve import resolve

        cfg = resolve(None, extra={"field": [lens_path.parent.name]})
        rows = [
            c
            for c in cfg.criteria.values()
            if c["origin"]["kind"] == "field" and c["applies"] in ("peer", "both")
        ]
        if rows:
            lines.append("\n### Field review criteria\n")
            lines += [
                f"- [{c['content']}, {c['angle']}] {c['question']} ({c['why']})\n" for c in rows
            ]
    checklist = lens_data.get("technical_checklist", [])
    red_flags = lens_data.get("red_flags", [])
    if checklist:
        lines.append("\n### Technical Checklist\n")
        lines += [f"- [{i.get('category', '')}] {i.get('item', '')}\n" for i in checklist]
    if red_flags:
        lines.append("\n### Red Flags to Watch For\n")
        lines += [
            f"- [{rf.get('severity', 'warning')}] {rf.get('flag', '')}: {rf.get('explanation', '')}\n"
            for rf in red_flags
        ]
    return "\n\n## Domain Lens Context\n" + "".join(lines) if lines else ""


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
    from academia.read.ingest_pipeline import ingest_output_dir
    from academia.read.models import ResearchBrief
    from academia.read.reader import review_paper
    from academia.read.schema import load_data

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
    brief = ResearchBrief.from_dict(
        {"brief_id": "", "original_request": "", "research_objective": "", **brief_data}
    )

    # Lens context: the field's review criteria plus any checklist an override lens carries.
    if lens:
        from academia.core.paths import lens_file

        lens_path = lens_file(lens)
        if lens_path is not None:
            paper_text = lens_context(lens_path, load_data(lens_path)) + paper_text

    # Deep read
    card = review_paper(
        paper_text=paper_text,
        brief=brief,
        model_spec=model,
        candidate_id=candidate_id,
        title="",  # Will be extracted from paper.md
        language=output_language(topic_dir),
    )

    # Write output
    reading_dir = _ensure(topic_dir / "reading")
    card_dict: dict[str, Any] = card.to_dict()
    card_path = reading_dir / f"{candidate_id}_card.json"
    card_path.write_text(
        json.dumps(card_dict, indent=2, ensure_ascii=True, default=str), encoding="utf-8"
    )

    # Render markdown
    from academia.read.render import paper_card_to_markdown

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
    from academia.read.synthesis import compare_papers

    cards = load_cards(topic_dir, paper_ids)
    if not cards:
        raise ValueError("No paper cards found. Deep-read some papers first.")

    synthesis = compare_papers(cards, model_spec=model, language=output_language(topic_dir))

    # Write output
    notes_dir = _ensure(topic_dir / "notes")
    (notes_dir / "synthesis.md").write_text(synthesis, encoding="utf-8")

    return synthesis


# ---------------------------------------------------------------------------
# 6. Export & stats (wires orphaned render + plot)
# ---------------------------------------------------------------------------
