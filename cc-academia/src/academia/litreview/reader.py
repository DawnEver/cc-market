"""AI deep reading — produce structured PaperCard from full paper text.

Absorbed from ReviewAgent review.py.
"""

from __future__ import annotations

import json
import re
from typing import Any

from academia.litreview.models import Evidence, PaperCard, ResearchBrief, ResearchUse

_SYSTEM_PROMPT = """\
You are a critical academic reviewer. Read the paper and extract structured information.
Return ONLY valid JSON — no markdown fences, no commentary.

Output schema:
{
  "verdict": "deep-read" | "targeted-read" | "archive",
  "confidence": 0.0-1.0,
  "one_sentence": "one-sentence summary of the contribution",
  "technical_core": ["key method/technique 1", "key method/technique 2"],
  "evidence": [{"claim": "...", "locator": "Fig. X / Table Y / Section Z"}],
  "limitations": ["limitation 1", "limitation 2"],
  "research_use": [{"type": "adapt|compare|baseline|cite|discard", "note": "why"}],
  "next_action": "what to do with this paper",
  "open_questions": ["question 1", "question 2"]
}"""


def _build_user_prompt(paper_text: str, brief: ResearchBrief) -> str:
    """Assemble the user prompt with research context and paper content."""
    criteria = "\n".join(f"- {c}" for c in brief.inclusion_criteria) if brief.inclusion_criteria else "(none)"
    exclusions = "\n".join(f"- {c}" for c in brief.exclusion_criteria) if brief.exclusion_criteria else "(none)"

    max_chars = 24000  # safe limit for most models
    truncated = paper_text if len(paper_text) <= max_chars else paper_text[:max_chars] + "\n\n[TRUNCATED]"

    return f"""\
## Research Objective
{brief.research_objective}

## Inclusion Criteria
{criteria}

## Exclusion Criteria
{exclusions}

## Paper Content
{truncated}"""


def _parse_json_response(raw: str | None) -> dict[str, Any]:
    """Extract JSON object from model response, with fence stripping."""
    if not raw:
        return {}
    # Strip markdown fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Try to find a JSON object in the text
        m = re.search(r"\{[\s\S]*\}", cleaned)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return {}


def review_paper(
    paper_text: str,
    brief: ResearchBrief,
    model_spec: str | None = None,
    candidate_id: str = "",
    title: str = "",
) -> PaperCard:
    """Deep-read a single paper and return a structured PaperCard.

    Args:
        paper_text: Full text of the paper (or as much as available).
        brief: Research brief with objectives and criteria.
        model_spec: Model registry key (defaults to 'gemini-2.5-flash').
        candidate_id: Optional candidate identifier.
        title: Optional paper title.

    Returns:
        PaperCard with structured review output.
    """
    from academia.core.ai import chat_structured

    model_key = model_spec or "gemini-2.5-flash"
    prompt = _build_user_prompt(paper_text, brief)
    raw = chat_structured(model_key, system=_SYSTEM_PROMPT, prompt=prompt)
    data = _parse_json_response(raw)

    def _str_list(items: Any) -> list[str]:
        if isinstance(items, list):
            return [str(i) for i in items]
        return []

    def _evidence_list(items: Any) -> list[Evidence]:
        if isinstance(items, list):
            return [
                Evidence(claim=str(e.get("claim", "")), locator=str(e.get("locator", "")))
                for e in items
                if isinstance(e, dict)
            ]
        return []

    def _use_list(items: Any) -> list[ResearchUse]:
        if isinstance(items, list):
            return [
                ResearchUse(type=str(u.get("type", "")), note=str(u.get("note", "")))
                for u in items
                if isinstance(u, dict)
            ]
        return []

    return PaperCard(
        candidate_id=candidate_id or "",
        title=title or "",
        verdict=data.get("verdict", "targeted-read"),
        confidence=float(data.get("confidence", 0.0)),
        one_sentence=str(data.get("one_sentence", "")),
        technical_core=_str_list(data.get("technical_core")),
        evidence=_evidence_list(data.get("evidence")),
        limitations=_str_list(data.get("limitations")),
        research_use=_use_list(data.get("research_use")),
        next_action=str(data.get("next_action", "")),
        open_questions=_str_list(data.get("open_questions")),
    )
