"""Cross-paper synthesis — compare, theme, and rank across PaperCards."""

from __future__ import annotations

from academia.litreview.models import PaperCard

_SYNTHESIS_SYSTEM = """\
You are a research synthesizer. Compare the provided paper summaries and identify:
1. Common themes and patterns across papers
2. Contradictions or disagreements between papers
3. Gaps — what important questions remain unaddressed

Write a concise synthesis (3-5 paragraphs). Be specific; reference individual papers by title."""


def compare_papers(cards: list[PaperCard], model_spec: str | None = None) -> str:
    """Identify themes, contradictions, and gaps across a set of papers.

    Args:
        cards: List of PaperCard objects from deep reading.
        model_spec: Optional model key (defaults to 'gemini-2.5-flash').

    Returns:
        A synthesis string in natural language.
    """
    if not cards:
        return "No papers to compare."

    summaries: list[str] = []
    for i, card in enumerate(cards, 1):
        title = card.title or f"Paper {i}"
        core = "; ".join(card.technical_core) if card.technical_core else "N/A"
        limitations = "; ".join(card.limitations) if card.limitations else "none noted"
        summaries.append(
            f"[{i}] {title}\n"
            f"    Summary: {card.one_sentence}\n"
            f"    Technical core: {core}\n"
            f"    Limitations: {limitations}"
        )

    prompt = "## Paper Summaries\n\n" + "\n\n".join(summaries)
    model_key = model_spec or "gemini-2.5-flash"
    from academia.core.ai import chat_structured
    result = chat_structured(model_key, system=_SYNTHESIS_SYSTEM, prompt=prompt)
    return result or "Synthesis failed."


def rank_by_relevance(
    cards: list[PaperCard],
    criteria: list[str],
) -> list[PaperCard]:
    """Rank papers by how many criteria keywords appear in their one-sentence summary.

    Args:
        cards: List of PaperCard objects.
        criteria: List of keyword/phrase strings to match against.

    Returns:
        Cards sorted by descending relevance score.
    """
    if not criteria:
        return list(cards)

    lowered_criteria = [c.lower() for c in criteria]

    def _score(card: PaperCard) -> int:
        text = (card.one_sentence + " " + " ".join(card.technical_core)).lower()
        return sum(1 for kw in lowered_criteria if kw in text)

    scored = [(_score(c), c) for c in cards]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored]
