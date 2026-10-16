"""The workspace's [output] language reaches every human-readable AI output."""

from __future__ import annotations

import json

import pytest

from academia.litreview import reader, synthesis, workflow_read
from academia.litreview.models import PaperCard, ResearchBrief


@pytest.fixture
def captured(monkeypatch):
    calls: list[dict] = []

    def fake_chat(model, *, system, prompt):
        calls.append({"system": system, "prompt": prompt})
        return json.dumps({"verdict": "archive", "one_sentence": "x"})

    monkeypatch.setattr("academia.core.ai.chat_structured", fake_chat)
    return calls


def _brief() -> ResearchBrief:
    return ResearchBrief.from_dict({"brief_id": "", "original_request": "", "research_objective": "o"})


def test_english_default_adds_no_language_instruction(captured):
    reader.review_paper("text", _brief())
    synthesis.compare_papers([PaperCard(candidate_id="a", title="T")])
    assert all("Simplified Chinese" not in c["system"] for c in captured)


def test_chinese_switches_prose_but_keeps_keys_and_metadata(captured):
    reader.review_paper("text", _brief(), language="zh-CN")
    synthesis.compare_papers([PaperCard(candidate_id="a", title="T")], language="zh-CN")
    for call in captured:
        assert "Simplified Chinese" in call["system"]
        assert "titles" in call["system"]
    assert "enum" in captured[0]["system"]


def test_unknown_language_tag_is_passed_through(captured):
    synthesis.compare_papers([PaperCard(candidate_id="a", title="T")], language="ja")
    assert "ja" in captured[0]["system"]


@pytest.mark.parametrize(
    ("toml", "expected"),
    [(None, "en"), ("", "en"), ('[output]\nlanguage = "zh-CN"\n', "zh-CN")],
)
def test_workspace_language_resolution(tmp_path, toml, expected):
    if toml is not None:
        (tmp_path / "workspace.toml").write_text(toml, encoding="utf-8")
    assert workflow_read.output_language(tmp_path) == expected


def test_synthesize_uses_workspace_language(tmp_path, captured):
    (tmp_path / "workspace.toml").write_text('[output]\nlanguage = "zh-CN"\n', encoding="utf-8")
    reading = tmp_path / "reading"
    reading.mkdir()
    (reading / "a_card.json").write_text(json.dumps(PaperCard(candidate_id="a", title="T").to_dict()), encoding="utf-8")
    workflow_read.run_synthesize(tmp_path)
    assert "Simplified Chinese" in captured[0]["system"]


@pytest.mark.parametrize(("argv", "expected"), [([], "en"), (["--language", "zh-CN"], "zh-CN")])
def test_init_records_the_language(tmp_path, monkeypatch, argv, expected):
    from academia.cli.dispatch import lit_review_main as main

    monkeypatch.setenv("ACADEMIA_DATA_ROOT", str(tmp_path))
    assert main(["init", "My Topic", *argv]) == 0
    ws = next(tmp_path.rglob("my-topic"))
    assert workflow_read.output_language(ws) == expected
