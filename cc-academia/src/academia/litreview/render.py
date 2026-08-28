"""Output rendering — PaperCard to markdown and CSV.

Absorbed from ReviewAgent csv2md.py.
"""

from __future__ import annotations

import csv
from pathlib import Path

from academia.litreview.models import PaperCard


def _escape_md(text: object) -> str:
    """Escape pipe characters and newlines for markdown table cells."""
    s = "" if text is None else str(text)
    return s.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").replace("|", "\\|")


def paper_card_to_markdown(card: PaperCard) -> str:
    """Render a single PaperCard as a compact markdown block (~700 words target).

    Includes: verdict badge, one-sentence summary, technical core table,
    evidence list, limitations, research use, open questions.
    """
    verdict_emoji = {"deep-read": "[DEEP]", "targeted-read": "[TARGETED]", "archive": "[ARCHIVE]"}
    badge = verdict_emoji.get(card.verdict, f"[{card.verdict.upper()}]")

    lines: list[str] = [
        f"## {badge} {card.title or '(untitled)'}",
        "",
        f"**Verdict:** {card.verdict}  |  **Confidence:** {card.confidence:.0%}",
        "",
        f"> {card.one_sentence or '(no summary)'}",
        "",
    ]

    # Technical core
    if card.technical_core:
        lines.append("### Technical Core")
        for item in card.technical_core:
            lines.append(f"- {item}")
        lines.append("")

    # Evidence
    if card.evidence:
        lines.append("### Evidence")
        lines.append("| Claim | Locator |")
        lines.append("|-------|---------|")
        for ev in card.evidence:
            lines.append(f"| {_escape_md(ev.claim)} | {_escape_md(ev.locator)} |")
        lines.append("")

    # Limitations
    if card.limitations:
        lines.append("### Limitations")
        for lim in card.limitations:
            lines.append(f"- {lim}")
        lines.append("")

    # Research use
    if card.research_use:
        lines.append("### How to Use This Paper")
        lines.append("| Type | Note |")
        lines.append("|------|------|")
        for ru in card.research_use:
            lines.append(f"| {_escape_md(ru.type)} | {_escape_md(ru.note)} |")
        lines.append("")

    # Open questions
    if card.open_questions:
        lines.append("### Open Questions")
        for q in card.open_questions:
            lines.append(f"- {q}")
        lines.append("")

    if card.next_action:
        lines.append(f"**Next action:** {card.next_action}")
        lines.append("")

    return "\n".join(lines)


def cards_to_csv(cards: list[PaperCard], path: Path) -> None:
    """Export a list of PaperCards to a CSV file.

    Columns: candidate_id, title, verdict, confidence, one_sentence,
    technical_core, limitations, research_use, next_action, open_questions.
    List fields are joined with '; '.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "candidate_id", "title", "verdict", "confidence", "one_sentence",
        "technical_core", "limitations", "research_use", "next_action", "open_questions",
    ]

    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for card in cards:
            writer.writerow({
                "candidate_id": card.candidate_id,
                "title": card.title,
                "verdict": card.verdict,
                "confidence": f"{card.confidence:.2f}",
                "one_sentence": card.one_sentence,
                "technical_core": "; ".join(card.technical_core),
                "limitations": "; ".join(card.limitations),
                "research_use": "; ".join(f"{ru.type}:{ru.note}" for ru in card.research_use),
                "next_action": card.next_action,
                "open_questions": "; ".join(card.open_questions),
            })
