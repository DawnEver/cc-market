"""Knowledge resolution: jurisdiction, dimensions, rule <-> check cross-reference, MAPPING completeness."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from academia import figure
from academia.check import numbers, pages, prose, table
from academia.knowledge import resolve as resolve_mod
from academia.knowledge.resolve import compile_term, knowledge_root, read_tsv, resolve

from .helpers import (
    DIM_HEAD,
    PRESET_ID,
    RULE_HEAD,
    VAL_HEAD,
    VOC_HEAD,
    cleanup,
    knowledge_tree,
    profile,
    rule,
    run_cli,
    tmp_tree,
    tsv,
)

FIGURE = Path(figure.__file__).parent
FIGURE_CHECKS = re.findall(r'add\(\s*"([\w-]+)"', (FIGURE / "check.py").read_text(encoding="utf-8"))
ALL_SOURCES = [
    ["venue", "ieee"],
    ["venue", "iemdc-2027"],
    ["field", "electrical-machine-design"],
    ["field", "power-electronics-drives"],
    ["preset", PRESET_ID],
]


@pytest.fixture()
def project_dir():
    made: list[Path] = []

    def make(rows, files=None):
        d = tmp_tree({".academia/profile.tsv": profile(rows), **(files or {})})
        made.append(d)
        return d

    yield make
    for d in made:
        cleanup(d)


def test_shipped_knowledge_resolves_without_jurisdiction_errors():
    cfg = resolve(None)
    assert cfg.errors == []
    assert len(cfg.rules) > 80
    assert len(cfg.criteria) > 30


def test_every_source_and_field_resolves_together(project_dir):
    p = project_dir(
        [
            *ALL_SOURCES,
            ["field", "computational-mechanics-optimisation"],
            ["field", "music-information-retrieval"],
            ["dimension", "spelling.variant", "british", "ruling"],
        ]
    )
    assert resolve(p).errors == []


def test_every_lint_check_named_by_a_rule_is_implemented_and_the_reverse(project_dir):
    cfg = resolve(project_dir(ALL_SOURCES))
    named = {r["check"][5:] for r in cfg.rules.values() if r["check"].startswith("lint:")}
    impl = {
        *prose.CHECKS,
        *table.CHECKS,
        *numbers.CHECKS,
        *pages.CHECKS,
        *FIGURE_CHECKS,
    }
    for c in named:
        assert c in impl, f"rule check lint:{c} has no implementation"
    for c in impl:
        assert c in named, f"check {c} is implemented but no rule names lint:{c}"


def test_dimension_values_come_from_the_owner_and_defaults_are_reported():
    k = knowledge_tree()
    p = tmp_tree({".academia/profile.tsv": profile([["preset", "me"], ["venue", "v1"]])})
    try:
        cfg = resolve(p, knowledge=k)
        assert cfg.errors == []
        assert cfg.dimensions["tone"]["value"] == "ornate"
        assert cfg.dimensions["tone"]["source"] == "preset me"
        assert cfg.dimensions["limit"]["value"] == "5"
        none = resolve(None, knowledge=k)
        assert none.dimensions["tone"]["value"] == "plain"
        assert none.dimensions["tone"]["defaultUsed"] is True
    finally:
        cleanup(k)
        cleanup(p)


def errors_for(extra, prof=None, project_files=None) -> str:
    prof = (
        prof
        if prof is not None
        else [["preset", "me"], ["venue", "v1"], ["field", "f1"], ["field", "f2"]]
    )
    k = knowledge_tree(extra)
    p = tmp_tree({".academia/profile.tsv": profile(prof), **(project_files or {})})
    try:
        return "\n".join(resolve(p, knowledge=k).errors)
    finally:
        cleanup(k)
        cleanup(p)


def test_jurisdiction_value_in_a_source_that_does_not_own_it_names_its_owner():
    e = errors_for({"fields/f1/prose/values.tsv": tsv([VAL_HEAD, ["tone", "plain", "x"]])})
    assert re.search(r"tone is owned by preset, not field; set it in the preset source", e)


def test_jurisdiction_correctness_rule_outside_common_is_rejected():
    e = errors_for(
        {"fields/f1/prose/rules.tsv": tsv([RULE_HEAD, rule("grammar.z", "prose", "field")])}
    )
    assert (
        "grammar.z is a correctness rule; it belongs in knowledge/common/prose/rules.tsv and no source can relax it"
        in e
    )


def test_jurisdiction_no_source_redefines_a_common_rule():
    e = errors_for(
        {"fields/f1/prose/rules.tsv": tsv([RULE_HEAD, rule("style.y", "prose", "field")])}
    )
    assert (
        "rule style.y is already defined at common/prose/rules.tsv:3 (common); sources never override or relax"
        in e
    )


def test_jurisdiction_venue_holds_must_rules_only():
    e = errors_for(
        {
            "venues/v1/prose/rules.tsv": tsv(
                [RULE_HEAD, rule("v1.style", "prose", "venue", "principle")]
            )
        }
    )
    assert 'venue rule v1.style is "principle"; a venue holds format requirements (must) only' in e


def test_jurisdiction_source_column_content_folder_unknown_dimension_bad_option_no_evidence():
    e = errors_for(
        {
            "fields/f1/figure/rules.tsv": tsv([RULE_HEAD, rule("me.a", "prose", "common")]),
            "presets/me/table/values.tsv": tsv([VAL_HEAD, ["nosuch", "x", "y"]]),
            "venues/v1/reference/values.tsv": tsv([VAL_HEAD]),
        },
        [["preset", "me"], ["venue", "v1"], ["field", "f1"]],
    )
    assert 'rule me.a says source "common" but sits in a field source' in e
    assert 'rule me.a has content "prose"; it belongs in knowledge/fields/f1/prose/rules.tsv' in e
    assert 'no dimension "nosuch" is defined' in e
    assert 'tone="loud" is not one of the options "plain,ornate"' in errors_for(
        {"presets/me/prose/values.tsv": tsv([VAL_HEAD, ["tone", "loud", "r"]])}
    )
    assert "tone has no evidence" in errors_for(
        {"presets/me/prose/values.tsv": tsv([VAL_HEAD, ["tone", "plain", ""]])}
    )


def test_jurisdiction_two_sources_of_one_kind_disagreeing_is_an_error():
    e = errors_for(
        {"venues/v2/prose/values.tsv": tsv([VAL_HEAD, ["limit", "6", "other venue"]])},
        [["venue", "v1"], ["venue", "v2"]],
    )
    assert 'limit="6" conflicts with "5" from venue v1' in e


def test_jurisdiction_spelling_outside_common_definitions_outside_common_unknown_source():
    e = errors_for(
        {
            "fields/f1/prose/vocabulary/x.tsv": tsv(
                [VOC_HEAD, ["color", "spelling", "colour", "pair", "mech", "field", "all"]]
            ),
            "fields/f1/prose/dimensions.tsv": tsv(
                [DIM_HEAD, ["z", "prose", "a,b", "a", "preset", "w"]]
            ),
        },
        [["preset", "me"], ["field", "f1"], ["field", "nope"]],
    )
    assert (
        "spelling pairs are language correctness; they belong in knowledge/common/prose/vocabulary/spelling.tsv"
        in e
    )
    assert "dimension definitions live in knowledge/common/prose/dimensions.tsv" in e
    assert (
        'no field source "nope" in knowledge/fields/ (have: f1, f2); create it with the field-reading workflow'
        in e
    )


def test_jurisdiction_project_dimension_needs_project_ownership_and_project_rules_cannot_override():
    e = errors_for(
        {},
        [["preset", "me"], ["dimension", "tone", "plain", "x"]],
        {".academia/rules.tsv": tsv([RULE_HEAD, rule("style.y", "prose", "project")])},
    )
    assert "tone is owned by preset, not project" in e
    assert re.search(
        r"rule style\.y is already defined .*a project never overrides another source", e
    )


def test_spelling_variant_is_owned_by_the_project():
    """User ruling: the English variant is a project choice (profile.tsv), not a preset choice."""
    assert resolve(None).dimensions["spelling.variant"]["owner"] == "project"
    presets = knowledge_root() / "presets"
    assert not any(
        "spelling.variant" in f.read_text(encoding="utf-8") for f in presets.rglob("values.tsv")
    )


def test_compile_term_literal_phrases_word_bounded_and_regex_keeps_flags():
    assert compile_term("heavy duty").search("Heavy duty use")
    assert not compile_term("duty").search("heavy-duty")
    assert compile_term("/^How\\b/").search("How it works")
    assert not compile_term("/^How\\b/").search("how it works")


def test_cli_md_lists_rules_with_provenance_and_missing_profile_exits_2(
    capsys, monkeypatch, tmp_path
):
    code, out, _ = run_cli(["resolve", "--md"], tmp_path, capsys, monkeypatch)
    assert code == 0
    assert "**cohesion.hook-previous** (common; must" in out
    code, _, err = run_cli(
        ["resolve", "--project", str(knowledge_root())], tmp_path, capsys, monkeypatch
    )
    assert code == 2
    assert "no .academia/profile.tsv; create one" in err


def test_mapping_accounts_for_every_old_item_and_names_existing_rules(project_dir):
    rows, _ = read_tsv(knowledge_root() / "MAPPING.tsv")
    old = {r["old_id"] for r in rows}
    for n in range(1, 47):
        assert f"writing-style#{n}" in old, f"rule {n} missing"
    for n in range(1, 25):
        assert f"P{n}" in old, f"P{n} missing"
    assert "writing-style#meta" in old
    for i in [
        "33-whereas",
        "31-relative",
        "29-tail",
        "22-nested",
        "26-verb",
        "22-announce",
        "25-vague",
        "22-nounclause",
        "size",
        "44-allocation",
        "46-tense",
        "33-openers",
        "26-its",
        "length",
        "bare",
        "40-english",
    ]:
        assert f"lint:{i}" in old, i
    for r in rows:
        assert r["action"] in ("moved", "split", "merged", "dropped"), (
            f"{r['old_id']}: action {r['action']}"
        )
        if r["action"] == "dropped":
            assert len(r["note"]) > 10, f"{r['old_id']}: dropped without a reason"
    cfg = resolve(project_dir(ALL_SOURCES))
    for r in rows:
        for i in re.split(r"[,;]\s*", r["new_id"]):
            if re.fullmatch(r"[a-z][\w-]*\.[\w.-]+", i) and not re.search(r"\.(tsv|md|py)$", i):
                assert (
                    i in cfg.rules
                    or i in cfg.dimensions
                    or i in cfg.criteria
                    or i.startswith("project.")
                ), f"{r['old_id']}: {i} is not a rule, dimension or criterion"
        assert r["decision"], f"{r['old_id']}: no decision note"


def test_mapping_destinations_exist():
    """Every MAPPING destination in the plugin exists (project paths live in the paper)."""
    rows, _ = read_tsv(knowledge_root() / "MAPPING.tsv")
    plugin = knowledge_root().parent
    missing = []
    for r in rows:
        for d in r["destination"].split(";"):
            d = re.sub(r"\s*\(.*?\)\s*$", "", d.strip())
            if d and d != "n/a" and not d.startswith("<paper>/") and not (plugin / d).exists():
                missing.append(f"{r['old_id']}: {d}")
    assert missing == []


def test_heading_style_is_a_preset_dimension_set_to_topic(project_dir):
    """User review 2026-11-23 C12: declarative or topic, owned by the preset (P2-G7)."""
    d = resolve(None).dimensions["heading.style"]
    assert (d["owner"], d["options"], d["value"]) == ("preset", "declarative,topic", "declarative")
    cfg = resolve(project_dir([["preset", PRESET_ID]]))
    assert cfg.dimensions["heading.style"]["value"] == "topic"
    assert "heading.style" in cfg.rules["heading.style"]["statement"]
    assert "caption.states-finding" in cfg.rules


def test_axis_unit_brackets_owned_by_the_preset_and_no_venue_sets_it(project_dir):
    """User review 2026-11-23 C13: the preset owns the choice; IEEE parentheses is a venue note only."""
    cfg = resolve(project_dir(ALL_SOURCES))
    d = cfg.dimensions["figure.axis-unit-brackets"]
    assert (d["owner"], d["value"], d["source"]) == ("preset", "brackets", f"preset {PRESET_ID}")
    assert not (knowledge_root() / "venues" / "ieee" / "figure" / "values.tsv").exists()
    assert "parentheses" in (knowledge_root() / "venues" / "ieee" / "README.md").read_text(
        encoding="utf-8"
    )


def test_self_reference_offers_options_by_format():
    """User review 2026-11-23 C6."""
    opts = resolve(None).dimensions["self-reference"]["options"].split(",")
    for o in ["this-paper", "this-digest", "either"]:
        assert o in opts


def test_intro_rule_tied_to_venue_format_short_and_conclusion_copy_is_a_criterion(project_dir):
    """User review 2026-11-23 C10/C14."""
    common = resolve(None)
    assert common.dimensions["format.short"]["owner"] == "venue"
    assert common.dimensions["format.short"]["value"] == "no"
    assert "format.short" in common.rules["structure.intro-no-abstract-repeat"]["statement"]
    assert "structure.no-abstract-repetition" not in common.rules
    c = common.criteria["structure.conclusion-not-abstract-copy"]
    assert (c["scope"], c["applies"], c["origin"]["kind"]) == ("conclusion", "both", "common")
    assert "structure.conclusion-not-abstract-copy" not in common.rules, (
        "a criterion, not a lint rule"
    )
    cfg = resolve(project_dir(ALL_SOURCES))
    assert cfg.dimensions["format.short"]["value"] == "yes"


def test_moved_rules_live_in_common_and_left_the_preset(project_dir):
    """User review 2026-11-23 C2, C5, E1; P2-G7 moved the last author rules to common."""
    cfg = resolve(project_dir([["preset", PRESET_ID]]))
    for rid in [
        "author.figure-change-approval",
        "author.one-item-at-a-time",
        "author.allocation-wording",
    ]:
        assert rid not in cfg.rules, rid
    for rid in ["abstract.finding-then-value"]:
        assert cfg.rules[rid]["origin"]["kind"] == "common", rid
    common_contrast = [
        v for v in resolve(None).vocabulary if v["term"].lower() in ("in contrast", "however")
    ]
    assert common_contrast == [], "common recommends no fixed contrast connective (C4)"
    assert (
        "in contrast" not in resolve(None).rules["sentence.no-contrast-join"]["statement"].lower()
    )


def test_field_weak_patterns_are_criteria_and_habits_replace_watch_lists():
    """User review 2026-11-23 D1-D4."""
    fields = knowledge_root() / "fields"
    assert not list(fields.rglob("watch-list.md"))
    for f in [
        "computational-mechanics-optimisation",
        "electrical-machine-design",
        "music-information-retrieval",
        "power-electronics-drives",
    ]:
        cfg = resolve(None, extra={"field": [f]})
        assert cfg.errors == []
        own = [c for c in cfg.criteria.values() if c["origin"]["name"] == f]
        assert own and all(c["applies"] == "both" for c in own), f
        weak = [r for r in cfg.rules.values() if r["origin"]["name"] == f and ".weak-" in r["id"]]
        assert weak == [], f
        habits = (fields / f / "prose" / "templates" / "habits.md").read_text(encoding="utf-8")
        assert "avoid" not in habits.lower() and "Related:" in habits, f
        assert (fields / f / "data" / "templates" / "conventions.md").exists(), f
    lens = (fields / "power-electronics-drives" / "lens.toml").read_text(encoding="utf-8")
    assert "[[red_flags]]" not in lens and "[[technical_checklist]]" not in lens


def test_scope_tokens_are_validated_and_policy_is_an_area_not_an_object():
    bad = dict(zip(RULE_HEAD, rule("me.s", "prose", "field"), strict=True))
    bad["scope"] = "results"
    e = errors_for({"fields/f1/prose/rules.tsv": tsv([RULE_HEAD, [bad[h] for h in RULE_HEAD]])})
    assert 'rule me.s scope "results" is not a scope' in e
    assert "editorial" not in resolve_mod.OBJECTS and "policy" in resolve_mod.AREAS
    assert '"editorial" is not an object type or area' in errors_for(
        {"common/editorial/rules.tsv": tsv([RULE_HEAD])}
    )


def test_scope_filter_keeps_all_and_named_parts_and_honours_exclusion():
    s = resolve_mod._scoped
    assert s({"scope": "all"}, "abstract") and s({"scope": "abstract,conclusion"}, "abstract")
    assert not s({"scope": "introduction"}, "abstract")
    assert not s({"scope": "!abstract"}, "abstract") and s({"scope": "!abstract"}, "body")


def test_lint_scope_maps_section_titles_to_parts():
    assert prose.part_of("Abstract") == "abstract" and prose.part_of("Conclusion") == "conclusion"
    assert prose.part_of("Loss Allocation Between Subspaces") == "body"
    assert prose._in_scope("body", {"section": "Results"})
    assert not prose._in_scope("body", {"section": "Introduction"})
    assert prose._in_scope("prose,!introduction", {"section": "Abstract"})


def test_group1_merges_leave_no_orphan_rules_and_add_two_dimensions():
    cfg = resolve(None)
    for rid in [
        "sentence.one-role",
        "sentence.no-bare-assertion",
        "sentence.no-inverted-relative",
        "sentence.which-tail",
        "sentence.no-relative-on-noun",
    ]:
        assert rid not in cfg.rules, rid
    assert cfg.rules["sentence.relative-clause"]["check"] == "lint:relative-clause"
    assert cfg.rules["sentence.no-semicolon-chain"]["check"] == "lint:semicolon-chain"
    assert (
        cfg.dimensions["sentence.relative-clause"]["options"] == "forbid,nonrestrictive-only,allow"
    )
    assert cfg.dimensions["connective.avoid"]["options"] == "words"


def test_group3_merges_and_roadmap_dimension(project_dir):
    cfg = resolve(project_dir([["venue", "iemdc-2027"]]))
    for gone in [
        "structure.one-topic-one-place",
        "argument.cross-reference-no-restatement",
        "structure.results-heading-style",
        "structure.broad-to-narrow",
        "abstract.role-before-symbol",
        "structure.roadmap",
        "terms.established-not-coined",
        "terms.descriptor-on-noun",
        "style.self-reference",
    ]:
        assert gone not in cfg.rules
    for rid in [
        "structure.one-place",
        "heading.style",
        "structure.funnel-opening",
        "introduction.roadmap",
        "terms.established-precise",
        "self-reference",
    ]:
        assert rid in cfg.rules
    assert cfg.rules["terms.established-precise"]["kind"] == "must"
    assert cfg.rules["structure.no-structure-preview"]["scope"] == "body"
    assert resolve_mod.dim(cfg, "introduction.roadmap") == "none"
    assert resolve_mod.dim(resolve(None), "introduction.roadmap") == "per-section"


def test_group_4_and_5_process_rules_live_in_skills_and_merges_are_complete(project_dir):
    """User review 2026-11-23 P2-G4, P2-G5."""
    cfg = resolve(project_dir(ALL_SOURCES))
    assert not [r for r in cfg.rules if r.startswith("process.")], (
        "process rules live in skills/write"
    )
    gone = [
        "wording.technical-precision",
        "wording.no-metaphor-term",
        "wording.background-verb",
        "wording.no-human-action",
        "wording.allocation-distribution",
        "style.conclusion-tense",
        "review-comment.active-voice",
        "review-comment.no-hedging",
        "review-comment.address-authors",
        "review-comment.one-variant",
        "review-comment.trace-to-draft",
        "figure.schematic-symbolic",
        "figure.no-notes-in-figure",
        "figure.data-template",
        "caption.holds-notes",
        "author.figure-iterate-rendered",
        "author.characteristic-marks",
    ]
    for rid in gone:
        assert rid not in cfg.rules, rid
    for rid in [
        "review-comment.direct",
        "figure.no-notes",
        "conclusion.tense",
        "document.page-limit",
    ]:
        assert rid in cfg.rules, rid
    assert cfg.dimensions["figure.characteristic-marks"]["value"] == "top-axis"
    assert cfg.dimensions["process.author-led-parts"]["owner"] == "project"
    assert "conclusion.self-tense" not in cfg.dimensions
    skill = (knowledge_root().parent / "skills" / "write" / "SKILL.md").read_text(encoding="utf-8")
    assert "## Hard constraints" in skill and "process.author-led-parts" in skill


def test_group6_merges_leave_no_orphan_rules(project_dir):
    """User review 2026-11-23 P2-G6."""
    cfg = resolve(project_dir(ALL_SOURCES))
    gone = [
        "table.unit-in-name",
        "table.unit-brackets",
        "data.number-registry",
        "data.no-hand-typed-number",
        "figure.scripted",
        "data.quantified-agreement",
        "author.numbers-are-specific",
        "author.size-of-small-change",
        "reference.verify-before-replace",
        "ieee.cross-reference-forms",
        "ieee.part-citation",
        "ieee.no-author-before-number",
    ]
    assert not [r for r in gone if r in cfg.rules]
    for r in [
        "table.unit",
        "data.registry",
        "data.reproducible",
        "data.quantify-claims",
        "ieee.citation-forms",
    ]:
        assert r in cfg.rules
    assert cfg.rules["data.registry"]["kind"] == "must"
    assert cfg.rules["emd.loss-from-physics"]["scope"] == "body"
    assert cfg.rules["ped.operating-point-per-result-figure"]["scope"] == "data-plot"


def test_group7_author_source_is_a_style_preset(project_dir):
    k = knowledge_root()
    assert not (k / "authors").exists() and (k / "presets" / PRESET_ID).is_dir()
    assert "preset" in resolve_mod.KINDS and "author" not in resolve_mod.KINDS
    cfg = resolve(project_dir([["preset", PRESET_ID]]))
    assert not cfg.errors, cfg.errors
    assert not [r for r in cfg.rules.values() if r["origin"]["kind"] == "preset"]
    r = cfg.rules["abstract.finding-then-value"]
    assert r["origin"]["kind"] == "common" and r["scope"] == "abstract,conclusion"
    assert cfg.dimensions["numbers.abstract-conclusion"]["owner"] == "preset"
    assert cfg.dimensions["abstract.result-sentences"]["defaultUsed"] is False
    fw = cfg.dimensions["conclusion.future-work"]
    assert (fw["owner"], fw["value"]) == ("project", "optional")
    assert "conclusion.future-work" in cfg.rules
    for gone in [
        "author.abstract-layer-budget",
        "author.compress-last",
        "author.conclusion-future-work",
    ]:
        assert gone not in cfg.rules
    assert any(
        t["path"].endswith("common/prose/templates/abstract-layers.md") for t in cfg.templates
    )


def test_group7_preset_holds_only_values_and_phrases():
    e = errors_for(
        {
            "presets/me/prose/rules.tsv": tsv([RULE_HEAD, rule("me.r", "prose", "preset")]),
            "presets/me/prose/vocabulary/x.tsv": tsv(
                [VOC_HEAD, ["foo", "forbidden", "", "", "w", "preset", "all"]]
            ),
            "presets/me/prose/templates/t.md": "# t\n",
        },
        [["preset", "me"]],
    )
    assert "a preset holds dimension values and recommended phrases only" in e
    assert e.count("a preset holds") >= 3
