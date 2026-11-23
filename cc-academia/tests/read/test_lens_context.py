"""A shipped field lens takes its review questions from the field's criteria (user review 2026-11-23 D4)."""

from __future__ import annotations

from academia.core.paths import lens_file
from academia.read.schema import load_data
from academia.read.workflow_read import lens_context


def test_field_lens_context_comes_from_the_field_criteria():
    path = lens_file("power-electronics")
    assert path is not None and path.parent.name == "power-electronics-drives"
    data = load_data(path)
    assert "technical_checklist" not in data and "red_flags" not in data
    text = lens_context(path, data)
    assert "### Field review criteria" in text
    assert "full loss breakdown" in text
    assert "(red flag, critical)" in text


def test_override_lens_keeps_its_own_checklist_and_red_flags(tmp_path):
    lens = tmp_path / "mine.toml"
    data = {
        "technical_checklist": [{"item": "Is the rating stated?", "category": "Specs"}],
        "red_flags": [
            {"flag": "No data", "severity": "critical", "explanation": "Nothing to check."}
        ],
    }
    text = lens_context(lens, data)
    assert "- [Specs] Is the rating stated?" in text
    assert "- [critical] No data: Nothing to check." in text
    assert "Field review criteria" not in text
    assert lens_context(lens, {}) == ""
