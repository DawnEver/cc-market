"""Tests for typed model serialization — the dict → dataclass refactor.

Every artifact that crosses a JSON boundary must reconstruct into fully
typed dataclasses (including nested lists), tolerating unknown keys.
"""

from __future__ import annotations

import json

import pytest

from academia.litreview.models import (
    Candidate,
    Evidence,
    PaperCard,
    ResearchBrief,
    ResearchUse,
    ScreeningDecision,
    Workspace,
)


# ---------------------------------------------------------------------------
# PaperCard — nested Evidence / ResearchUse must round-trip as objects
# ---------------------------------------------------------------------------

@pytest.fixture
def card() -> PaperCard:
    return PaperCard(
        candidate_id="IEEE-1",
        title="LLC Study",
        verdict="deep-read",
        confidence=0.9,
        one_sentence="A study.",
        technical_core=["resonant tank"],
        evidence=[Evidence(claim="98% efficiency", locator="Fig. 8")],
        limitations=["no thermal data"],
        research_use=[ResearchUse(type="baseline", note="compare topology")],
        next_action="replicate",
        open_questions=["scaling?"],
    )


def test_paper_card_round_trip(card):
    data = json.loads(json.dumps(card.to_dict()))
    restored = PaperCard.from_dict(data)

    assert restored == card
    assert isinstance(restored.evidence[0], Evidence)
    assert isinstance(restored.research_use[0], ResearchUse)


def test_paper_card_from_dict_ignores_unknown_keys(card):
    data = card.to_dict()
    data["artifact_version"] = 1
    data["extra_junk"] = {"x": 1}
    assert PaperCard.from_dict(data) == card


def test_reloaded_card_renders_markdown_and_csv(tmp_path, card):
    """Regression: rendering a JSON-reloaded card must not crash on nested fields."""
    from academia.litreview.export.render import cards_to_csv, paper_card_to_markdown

    restored = PaperCard.from_dict(json.loads(json.dumps(card.to_dict())))
    md = paper_card_to_markdown(restored)
    assert "98% efficiency" in md and "baseline" in md

    out = tmp_path / "cards.csv"
    cards_to_csv([restored], out)
    assert "baseline:compare topology" in out.read_text(encoding="utf-8-sig")


# ---------------------------------------------------------------------------
# Candidate
# ---------------------------------------------------------------------------

def test_candidate_from_dict_tolerant():
    row = {
        "candidate_id": "arxiv-1", "source_provider": "arxiv", "title": "T",
        "publication_year": "2024",          # string year must coerce
        "citation_count": None,               # None must coerce to 0
        "dedupe_rank": 3, "ranking_score": 1.5,  # dedupe extras ignored
    }
    c = Candidate.from_dict(row)
    assert c.publication_year == 2024
    assert c.citation_count == 0
    assert c.source_provider == "arxiv"


# ---------------------------------------------------------------------------
# ResearchBrief — accepts both flat and nested 'constraints' layout
# ---------------------------------------------------------------------------

def test_research_brief_from_dict_nested_constraints():
    brief = ResearchBrief.from_dict({
        "brief_id": "b1", "original_request": "r", "research_objective": "o",
        "inclusion_criteria": ["a"],
        "constraints": {"year_from": 2020, "year_to": 2025, "content_types": ["Journals"]},
        "concepts": [{"concept_id": "c1", "role": "must", "term": "LLC", "junk": 1}],
    })
    assert brief.year_from == 2020
    assert brief.concepts[0].term == "LLC"


def test_research_brief_round_trip():
    brief = ResearchBrief(brief_id="b1", original_request="r", research_objective="o")
    assert ResearchBrief.from_dict(brief.to_dict()) == brief


# ---------------------------------------------------------------------------
# ScreeningDecision / Workspace
# ---------------------------------------------------------------------------

def test_screening_decision_from_dict():
    d = ScreeningDecision.from_dict({
        "candidate_id": "x", "decision": "include", "confidence": 0.8,
        "inclusion_reasons": ["fits"], "title": "meta noise",
    })
    assert d.decision == "include"
    assert d.inclusion_reasons == ["fits"]


def test_workspace_from_dict_nested():
    ws = Workspace.from_dict({
        "workspace_id": "w1", "name": "W",
        "zotero": {"collection_key": "K"},
        "defaults": {"year_from": 2019},
        "providers": ["ieee_xplore", "arxiv"],
    })
    assert ws.zotero.collection_key == "K"
    assert ws.defaults.year_from == 2019
    assert ws.providers == ["ieee_xplore", "arxiv"]


# ---------------------------------------------------------------------------
# Orchestrator integration — reload path is typed end-to-end
# ---------------------------------------------------------------------------

def test_run_export_markdown_with_nested_card(tmp_path, card):
    from academia.litreview.workflow_export import run_export

    td = tmp_path / "workspaces" / "t"
    (td / "reading").mkdir(parents=True)
    (td / "reading" / "IEEE-1_card.json").write_text(
        json.dumps(card.to_dict()), encoding="utf-8",
    )

    out = run_export(td, format="markdown")
    text = out.read_text(encoding="utf-8")
    assert "98% efficiency" in text, "nested Evidence must survive reload"

    out_csv = run_export(td, format="csv")
    assert "baseline:compare topology" in out_csv.read_text(encoding="utf-8-sig")
