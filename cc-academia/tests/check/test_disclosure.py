"""Progressive disclosure: the context index, explain, and the context budget."""

from __future__ import annotations

import pytest

from academia.knowledge import resolve as R

from .helpers import PRESET_ID, cleanup, profile, tmp_tree

BUDGET = 25
_D = tmp_tree(
    {
        ".academia/profile.tsv": profile(
            [
                ["venue", "ieee"],
                ["venue", "iemdc-2027"],
                ["field", "electrical-machine-design"],
                ["field", "power-electronics-drives"],
                ["preset", PRESET_ID],
                ["dimension", "spelling.variant", "british", "ruling"],
            ]
        )
    }
)
FULL = R.resolve(_D)


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    cleanup(_D)


def _items(task, scope, applies=None, angles=None):
    lines = R.context_index(FULL, task, scope, applies, angles)
    return [line for line in lines if not line.startswith("= ")]


def test_index_excludes_lint_rules_and_keeps_all_and_named_part():
    lines = _items("write", "abstract")
    ids = [line.split(" ")[0] for line in lines]
    assert "cohesion.hook-previous" in ids and "structure.funnel-opening" in ids
    assert "sentence.max-words" not in ids  # lint: surfaces only as a hit
    assert "introduction.roadmap" not in ids and "heading.style" not in ids
    assert "figure.no-notes" not in ids  # another object
    assert all(" — " in line for line in lines)


def test_index_lists_dimension_values_for_the_scope():
    dims = [line for line in R.context_index(FULL, "write", "conclusion") if line.startswith("= ")]
    assert any(line.startswith("= conclusion.tense = present-perfect") for line in dims)


def test_review_task_lists_criteria_of_one_angle_only():
    own = [line.split(" ")[0] for line in _items("review", "body", "self", ["cohesion"])]
    assert own == ["review.links"]
    assert "cohesion.hook-previous" not in own  # rules belong to the write index
    with pytest.raises(ValueError):
        R.context_index(FULL, "draft", "body")
    with pytest.raises(ValueError):
        R.context_index(FULL, "write", "results")
    with pytest.raises(ValueError, match="one part at a time"):
        R.context_index(FULL, "write", "manuscript")


def test_title_and_keywords_take_only_items_naming_them():
    ids = [line.split(" ")[0] for line in _items("write", "title")]
    assert "title.no-generic-words" in ids and "cohesion.hook-previous" not in ids


ANGLES = sorted({c["angle"] for c in FULL.criteria.values()})


@pytest.mark.parametrize("scope", [s for s in R.INDEX_SCOPES if s != "manuscript"])
def test_context_budget_write(scope):
    n = len(_items("write", scope))
    assert n <= BUDGET, f"write/{scope}: {n} items > {BUDGET}; merge items or move them to lint"


@pytest.mark.parametrize("scope", R.INDEX_SCOPES)
@pytest.mark.parametrize("applies", ["self", "peer"])
def test_context_budget_review_per_angle(scope, applies):
    for angle in ANGLES:
        n = len(_items("review", scope, applies, [angle]))
        assert n <= BUDGET, f"review/{applies}/{angle}/{scope}: {n} items > {BUDGET}"


def test_explain_rule_criterion_and_dimension():
    r = R.explain(FULL, "sentence.relative-clause")
    assert "statement:" in r and "dimension sentence.relative-clause = nonrestrictive-only" in r
    assert "question:" in R.explain(FULL, "review.links")
    assert "options:" in R.explain(FULL, "conclusion.future-work")
    with pytest.raises(KeyError):
        R.explain(FULL, "no.such")


def test_every_lint_hit_names_a_rule_of_the_resolved_config():
    import re
    from pathlib import Path

    from academia.check.prose import lint_source, prepare
    from academia.check.table import lint_tables

    src = (
        "However, the loss clearly rises with regards to the load, which the machine cannot meet.\n"
        "The current which flows in the winding raises the loss; the iron loss also rises.\n"
        "The motor, has a high loss.\n"
    )
    hits = lint_source(src, "t.tex", prepare(FULL))
    assert hits and all(h["rule"] in FULL.rules for h in hits), [h["rule"] for h in hits]
    tab = "\begin{tabular}{ll}\nTemp. & 20 C/40 C \\\n\end{tabular}\n"
    assert all(h["rule"] in FULL.rules for h in lint_tables(tab, "t.tex", FULL))
    # Rule ids written in the check code itself (code checks, figure, pages, data).
    root = Path(R.__file__).parents[1]
    code = "".join(
        f.read_text(encoding="utf-8")
        for f in [*(root / "check").glob("*.py"), root / "figure" / "check.py"]
    )
    named = set(re.findall(r'"((?:[a-z]+\.[a-z][\w-]*)|self-reference)"', code))
    prefixes = {r.split(".")[0] for r in FULL.rules}
    ids = {n for n in named if n.split(".")[0] in prefixes and n not in FULL.dimensions}
    assert ids and ids <= set(FULL.rules), sorted(ids - set(FULL.rules))
