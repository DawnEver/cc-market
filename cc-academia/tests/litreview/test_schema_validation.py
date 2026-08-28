"""Data model validation tests — using Python dataclasses, not JSON Schema."""

from __future__ import annotations

from academia.litreview.brief import scope_sha256, validate_brief
from academia.litreview.models import (
    Candidate,
    PaperCard,
    ResearchBrief,
    Workspace,
)
from academia.litreview.schema import require_keys


def test_require_keys():
    assert require_keys({"a": 1}, "a") == []
    assert require_keys({"a": 1}, "a", "b") == ["b"]


def test_brief_validate_accepts_sample(sample_brief):
    errors = validate_brief(sample_brief)
    assert len(errors) == 0, str(errors)


def test_brief_validate_rejects_invalid():
    errors = validate_brief({"brief_id": "x"})
    assert len(errors) > 0


def test_sha256_stability(sample_brief):
    h1 = scope_sha256(sample_brief)
    h2 = scope_sha256(dict(sample_brief))
    assert h1 == h2
    assert len(h1) == 64


def test_sha256_sensitivity(sample_brief):
    h1 = scope_sha256(sample_brief)
    m = dict(sample_brief)
    m["research_objective"] = "Different"
    assert scope_sha256(m) != h1


def test_models_instantiate():
    ws = Workspace(workspace_id="test", name="Test")
    assert ws.workspace_id == "test"

    brief = ResearchBrief(brief_id="b1", original_request="x", research_objective="y")
    assert brief.brief_id == "b1"

    c = Candidate(candidate_id="c1", source_provider="ieee_xplore", title="Test Paper")
    assert c.candidate_id == "c1"

    pc = PaperCard(candidate_id="c1", title="Test", verdict="deep-read",
                   one_sentence="test", technical_core=["a"], evidence=[],
                   limitations=[], research_use=[])
    assert pc.verdict == "deep-read"
