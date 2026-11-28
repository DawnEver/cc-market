"""lint-prose: every vocabulary class and every check, positive and negative. Sentences are synthetic."""

from __future__ import annotations

import copy

import pytest

from academia.check.prose import lint_source, prepare, spelling
from academia.documents.tex import sentences
from academia.knowledge.resolve import resolve

from .helpers import PRESET_ID, cleanup, profile, run_cli, tmp_tree, tsv

COMMON = resolve(None)
_DIRS = []


def _project(rows, files=None):
    d = tmp_tree({".academia/profile.tsv": profile(rows), **(files or {})})
    _DIRS.append(d)
    return d


PRESET = resolve(_project([["preset", PRESET_ID]]))
FULL = resolve(
    _project(
        [
            ["venue", "ieee"],
            ["venue", "iemdc-2027"],
            ["field", "electrical-machine-design"],
            ["field", "power-electronics-drives"],
            ["preset", PRESET_ID],
            ["dimension", "spelling.variant", "british", "ruling"],
        ],
        {
            ".academia/vocabulary.tsv": tsv(
                [
                    ["term", "class", "replace", "when", "why", "source", "scope"],
                    [
                        "/\\bcogging\\b/i",
                        "canonical",
                        "detent",
                        "",
                        "terms.one-canonical: project ruling",
                        "project",
                        "all",
                    ],
                    [
                        "/\\bend ring\\b/i",
                        "canonical",
                        "short-circuit ring",
                        "",
                        "terms.one-canonical: project ruling",
                        "project",
                        "caption",
                    ],
                    [
                        "/\\bdual three-phase machine\\b/i",
                        "caution",
                        "DTP",
                        "after its definition",
                        "terms.one-canonical: project ruling",
                        "project",
                        "all",
                    ],
                    [
                        "measured + simulated",
                        "phrase",
                        "",
                        "legend",
                        "project ruling",
                        "project",
                        "caption",
                    ],
                ]
            )
        },
    )
)


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    for d in _DIRS:
        cleanup(d)


def hits(src, cfg=COMMON):
    return lint_source(src, "t.tex", prepare(cfg))


def ids(src, cfg=COMMON):
    return [h["rule"] for h in hits(src, cfg)]


def has(src, rid, cfg=COMMON):
    return rid in ids(src, cfg)


def test_configurations_resolve_cleanly():
    for c in (COMMON, PRESET, FULL):
        assert c.errors == []


def test_sentences_skip_floats_tokenise_cites_and_maths_with_lines_and_sections():
    s = sentences(
        "\\section{Results}\nA loss $P_s$ rises~\\cite{a}. It falls.\n\\begin{figure}\nNot prose.\n\\end{figure}\nNext line.\n"
    )
    assert [x["plain"] for x in s] == ["A loss M rises X.", "It falls.", "Next line."]
    assert [x["line"] for x in s] == [2, 2, 6]
    assert s[0]["section"] == "Results"
    assert sentences("$\\alpha\\beta$ frame holds.\n")[0]["text"] == "alpha beta frame holds."


# ---- vocabulary classes: one positive and one negative case each ----
def test_forbidden_fixed_phrase_misuse_is_an_error():
    h = next(
        x
        for x in hits("The skew is studied with regards to its influence on the noise.\n")
        if x["rule"] == "mech.fixed-phrase"
    )
    assert h["severity"] == "error"
    assert "with regard to" in h["message"]
    assert not has(
        "The skew is studied with regard to its influence on the noise.\n", "mech.fixed-phrase"
    )


def test_caution_nested_clause_and_contrast_join_warn_plain_sentences_do_not():
    assert has(
        "The model is a network in which the heat flows freely.\n", "sentence.no-nested-clause"
    )
    assert has(
        "The noise rises at low speed, but it falls at high speed.\n", "sentence.no-contrast-join"
    )
    assert not has(
        "The noise rises at low speed. In contrast, it falls at high speed.\n",
        "sentence.no-contrast-join",
    )
    assert has(
        "The noise rises at low speed, yet it falls at high speed.\n", "sentence.no-contrast-join"
    )
    assert not has("The noise has not yet been measured.\n", "sentence.no-contrast-join")


def test_canonical_project_and_venue_terms_suggest_the_replacement():
    h = next(
        x
        for x in hits("The cogging torque rises with the slot opening of the stator.\n", FULL)
        if x["rule"] == "terms.one-canonical"
    )
    assert "detent" in h["message"]
    assert not has(
        "The cogging torque rises with the slot opening of the stator.\n", "terms.one-canonical"
    )
    h = next(
        x
        for x in hits("The pump runs at 1500 rpm in the examined load case.\n", FULL)
        if x["rule"] == "ieee.units"
    )
    assert "r/min" in h["message"]


def test_hyphenate_compound_modifiers_before_a_noun_not_as_a_noun_phrase():
    h = hits("The heavy duty crane has high frequency vibration modes in its frame.\n")
    assert [x["message"].split('"')[1] for x in h if x["rule"] == "mech.compound-hyphen"] == [
        "heavy duty",
        "high frequency",
    ]
    assert not has(
        "The noise rises at high frequency and at low load in the crane.\n", "mech.compound-hyphen"
    )
    h = next(
        x
        for x in hits("The PWM induced currents rise with the switching frequency of the drive.\n")
        if x["rule"] == "mech.compound-hyphen"
    )
    assert "PWM-induced" in h["message"]
    assert not has(
        "The PWM-induced currents rise with the switching frequency of the drive.\n",
        "mech.compound-hyphen",
    )


def test_allocation_wording_is_project_vocabulary_not_common():
    """User review 2026-11-23 P2-G4: allocation/distribution is one paper's term, so a project declares it."""
    s = "The heat is split between the two cooling channels of the housing.\n"
    assert not [x for x in hits(s) if "allocation" in x["message"]], "common no longer carries it"
    assert "wording.allocation-distribution" not in COMMON.rules
    d = _project(
        [],
        {
            ".academia/vocabulary.tsv": tsv(
                [
                    ["term", "class", "replace", "when", "why", "source", "scope"],
                    [
                        "/\\b(split|splits|splitting)\\b/i",
                        "caution",
                        "allocation, distribution",
                        "dividing a quantity among parts",
                        "terms.one-canonical: project ruling",
                        "project",
                        "all",
                    ],
                ]
            )
        },
    )
    h = [x for x in hits(s, resolve(d)) if x["rule"] == "terms.one-canonical"]
    assert h and h[0]["severity"] == "warn" and "allocation, distribution" in h[0]["message"]


def test_collocation_wrong_preposition_flagged_right_one_passes():
    assert has(
        "The rotor is comprised of laminations and a cast cage winding.\n", "mech.fixed-phrase"
    )
    assert not has(
        "The rotor is composed of laminations and a cast cage winding.\n", "mech.fixed-phrase"
    )


def test_phrase_recommended_patterns_are_never_flagged():
    src = (
        "First, the rotor skew might lower the detent torque, which is 0.8\\,N.m in this case.\n"
        "Second, the skew moves the optimal slot opening towards noise minimisation.\n"
        "Therefore, accurate noise prediction becomes more pressing for compact pump motors.\n"
        "The distribution of slot harmonics would therefore influence the noise in the frame and the feet.\n"
        "In this paper, both angles are investigated with regard to their influence on the radial forces.\n"
    )
    r = [h for h in hits(src, FULL) if h["severity"] != "info"]
    assert [f"{h['rule']}: {h['message']}" for h in r] == []


def test_spelling_british_flags_american_spellings_with_line_and_suggestion():
    st = prepare(COMMON)
    h = spelling(
        "First line here.\nWe analyze the color of the modeled fiber at the center.\n",
        "british",
        st,
    )
    assert [f"{x['line']}:{x['word']}>{x['suggest']}" for x in h] == [
        "2:analyze>analyse",
        "2:color>colour",
        "2:modeled>modelled",
        "2:fiber>fibre",
        "2:center>centre",
    ]
    w = [
        f"{x['word']}>{x['suggest']}"
        for x in spelling(
            "Normalization and optimized behavior. Gray analog toward the millimeters, labeled and traveled, canceled.\n",
            "british",
            st,
        )
    ]
    for x in [
        "Normalization>Normalisation",
        "optimized>optimised",
        "behavior>behaviour",
        "Gray>Grey",
        "analog>analogue",
        "toward>towards",
        "millimeters>millimetres",
        "labeled>labelled",
        "traveled>travelled",
        "canceled>cancelled",
    ]:
        assert x in w, x


def test_spelling_american_flags_british_spellings_exception_words_never_flagged():
    st = prepare(COMMON)
    w = [
        f"{x['word']}>{x['suggest']}"
        for x in spelling(
            "We analyse the colour of the modelled fibre at the centre, normalised towards the grey analogue programme of 3 metres.\n",
            "american",
            st,
        )
    ]
    for x in [
        "analyse>analyze",
        "colour>color",
        "modelled>modeled",
        "fibre>fiber",
        "centre>center",
        "normalised>normalized",
        "towards>toward",
        "grey>gray",
        "analogue>analog",
        "programme>program",
        "metres>meters",
    ]:
        assert x in w, x
    assert (
        spelling("The size and prize seize the capsized maize; resized meshes.\n", "british", st)
        == []
    )
    assert (
        spelling(
            "We advise, exercise and comprise; a surprise revised the premise, otherwise precise noise rises and the analyses compromise.\n",
            "american",
            st,
        )
        == []
    )


def test_spelling_ignores_code_citations_comments_maths_and_bibliography_but_reads_captions():
    st = prepare(COMMON)
    src = r"""\begin{center}\color{gray}\scriptsize
\usepackage[usenames]{xcolor}\definecolor{mygray}{gray}{0.5}
\includegraphics[width=\linewidth]{fig/color_center.pdf}
As shown~\cite{optimization_center} in Fig.~\ref{fig:color}\label{sec:behavior}. % the color center
\[ x_{center} \] and $c_{color}$ hold.
\begin{equation}
  P_{behavior} = 0
\end{equation}"""
    assert spelling(src, "british", st) == []
    assert (
        spelling(
            "\\begin{thebibliography}{9}\n\\bibitem{a} A. B, Optimization of color.\n\\end{thebibliography}",
            "british",
            st,
        )
        == []
    )
    assert [x["word"] for x in spelling("\\caption{The gray center line.}", "british", st)] == [
        "gray",
        "center",
    ]


def test_spelling_variant_from_the_project_profile_none_disables_it():
    assert has(
        "The frame color changes with the load torque at this point.\n",
        "mech.spelling-variant",
        FULL,
    )
    assert not has(
        "The frame color changes with the load torque at this point.\n", "mech.spelling-variant"
    )


# ---- rule checks: positive and negative ----
def test_grammar_subject_verb_comma():
    assert has(
        "In the examined cases, the thermal network, is used to estimate the winding hot spot.\n",
        "grammar.subject-verb-comma",
    )
    assert not has(
        "In the examined cases, the thermal network is used to estimate the winding hot spot.\n",
        "grammar.subject-verb-comma",
    )
    assert not has(
        "The network, which the authors proposed, is used to estimate the winding hot spot.\n",
        "grammar.subject-verb-comma",
    )


def test_grammar_compound_subject_agreement():
    assert has(
        "Skew and rotor shaping widely applied to pump motors reduces the cogging torque.\n",
        "grammar.compound-subject-agreement",
    )
    assert not has(
        "Skew and rotor shaping widely applied to pump motors reduce the cogging torque.\n",
        "grammar.compound-subject-agreement",
    )
    assert not has(
        "First, the skew for these motors moves most of the harmonic into the stator and increases the noise.\n",
        "grammar.compound-subject-agreement",
    )


def test_mech_unit_spacing_degree_space_thin_space_and_option_values_ignored():
    assert has(
        "The angle moves from 12.5$^\\circ$ to 30.0 $^\\circ$ in this case here.\n",
        "mech.unit-spacing",
    )
    assert has("The pump delivers 75 kW at the rated point of the drive.\n", "mech.unit-spacing")
    assert has("The pump delivers 75kW at the rated point of the drive.\n", "mech.unit-spacing")
    assert not has(
        "The pump delivers 75\\,kW at 30$^\\circ$ and 3\\,\\% of the loss here.\n",
        "mech.unit-spacing",
    )
    assert not has("\\includegraphics[height=2.6cm]{a.jpg}\n", "mech.unit-spacing")


def test_mech_no_slash_list_units_like_r_per_min_pass():
    assert has(
        "The vibration adds frame/foot/bearing noise to the pump in this case.\n",
        "mech.no-slash-list",
    )
    assert not has(
        "The pump runs at 1500\\,r/min with frame, foot and bearing noise here.\n",
        "mech.no-slash-list",
    )


def test_relative_clause_follows_the_dimension():
    tail = "The noise rises with the slot opening, which excites the frame mode.\n"
    restrictive = "Motors that stay quiet over the duty cycle are increasingly required.\n"
    rid = "sentence.relative-clause"
    assert has(tail, rid) and has(restrictive, rid), "default forbid flags both"
    assert not has(tail, rid, PRESET) and has(restrictive, rid, PRESET), "nonrestrictive-only"
    allow = copy.deepcopy(PRESET)
    allow.dimensions[rid]["value"] = "allow"
    assert not has(tail, rid, allow) and not has(restrictive, rid, allow)


def test_semicolon_chain_is_flagged_outside_maths():
    rid = "sentence.no-semicolon-chain"
    assert has("The rotor heats; the stator cools; the frame rings.\n", rid)
    assert not has("The set $\\{a; b\\}$ holds two values for the rotor here.\n", rid)


def test_sentence_max_words_and_short_run_use_the_dimensions():
    long = "The " + " ".join(["noise"] * 36) + " rises.\n"
    assert has(long, "sentence.max-words", PRESET)
    assert not has(long, "sentence.max-words"), "38 by default"
    # F1: this author's value is 35; a 36-word sentence flags, a 35-word one does not.
    assert PRESET.dimensions["sentence.max-words"]["value"] == "35"
    assert COMMON.dimensions["sentence.max-words"]["value"] == "38"
    assert has("The " + " ".join(["noise"] * 34) + " rises.\n", "sentence.max-words", PRESET)
    assert not has("The " + " ".join(["noise"] * 33) + " rises.\n", "sentence.max-words", PRESET)
    assert has("These trends reverse. The noise falls.\n", "sentence.short-run")
    assert not has(
        "These trends reverse with the rotor skew angle of the motor. The noise falls.\n",
        "sentence.short-run",
    )


def test_sentence_opener_variety_connectives_do_not_count():
    assert has(
        "Under load, the frame noise rises by a clear margin.\nIn the steady state, the bearing loss changes little.\n",
        "sentence.opener-variety",
    )
    assert not has(
        "Under load, the frame noise rises by a clear margin.\nAs a result, the bearing loss changes little.\n",
        "sentence.opener-variety",
    )
    # C4: common recommends no contrast connective; "In contrast" is the author's own connective.
    two = "Under load, the frame noise rises by a clear margin.\nIn contrast, the bearing loss changes little.\n"
    assert has(two, "sentence.opener-variety")
    assert not has(two, "sentence.opener-variety", PRESET)
    assert not has(
        "First, the frame noise rises by a clear margin.\nSecond, the bearing loss changes little.\n",
        "sentence.opener-variety",
    )


def test_pronoun_run_technical_verbs_human_action_and_novelty():
    assert has(
        "Its noise rises with the speed here.\nIts torque falls with the speed here.\n",
        "sentence.no-pronoun-run",
    )
    assert has(
        "The rotor sees a much larger airgap in the axial direction here.\n",
        "wording.technical-verbs",
    )
    assert has(
        "Motors pursuing higher efficiency are increasingly common in pumps.\n",
        "wording.technical-verbs",
    )
    assert has(
        "Its novelty is the coupled model of the pump and the motor.\n",
        "argument.no-announced-novelty",
    )


def test_style_self_reference_other_document_names_in_subject_position():
    assert has("This digest analyses the radial forces of the pump motor.\n", "self-reference")
    assert not has("This paper analyses the radial forces of the pump motor.\n", "self-reference")
    assert not has(
        "In this digest, both angles are investigated for their influence on the noise.\n",
        "self-reference",
    )


def test_style_self_reference_either_allows_this_paper_or_the_format_name_only():
    """User review 2026-11-23 C6: the author's value is either."""
    assert PRESET.dimensions["self-reference"]["value"] == "either"
    for ok in ["This paper", "This digest"]:
        assert not has(
            f"{ok} analyses the radial forces of the pump motor.\n", "self-reference", PRESET
        ), ok
    for other in ["This work", "This study"]:
        h = [
            x
            for x in hits(f"{other} analyses the radial forces of the pump motor.\n", PRESET)
            if x["rule"] == "self-reference"
        ]
        assert h and '"This paper"' in h[0]["message"] and "either" in h[0]["message"], other


def test_structure_preview_section_by_section_is_flagged_scope_statement_is_not():
    """User review 2026-11-23 C7."""
    for s in [
        "Section III describes the thermal model and Section IV discusses the results.",
        "The rest of this paper is organised as follows in four parts.",
        "The loss components are separated as discussed below for each frequency.",
    ]:
        assert has(f"\\section{{Model}}\n{s}\n", "structure.no-structure-preview"), s
    assert not has(
        "\\section{Model}\nIn this paper, the bearing currents of the pump motor are investigated at two cable lengths.\n",
        "structure.no-structure-preview",
    )
    assert not has(
        "\\section{Introduction}\nSection III describes the thermal model of the pump motor.\n",
        "structure.no-structure-preview",
    ), "the roadmap lives in the introduction (introduction.roadmap)"


def test_conclusion_tense_only_in_the_conclusion_when_the_author_chose_present_perfect():
    body = "This paper analysed the radial forces of the skewed pump motor.\n"
    assert has(f"\\section{{Conclusion}}\n{body}", "conclusion.tense", PRESET)
    assert not has(f"\\section{{Results}}\n{body}", "conclusion.tense", PRESET)
    assert not has(
        "\\section{Conclusion}\nThis paper has analysed the radial forces of the motor.\n",
        "conclusion.tense",
        PRESET,
    )
    assert not has(f"\\section{{Conclusion}}\n{body}", "conclusion.tense"), "default any"


def test_connective_avoid_words_flag_under_no_contrast_join_hardly_cautioned():
    rid = "sentence.no-contrast-join"
    however = "However, the noise rises with the slot opening of the stator.\n"
    assert has(however, rid, PRESET)
    assert has(
        "The frame noise rises with the load, whereas the bearing noise falls.\n", rid, PRESET
    )
    assert has(
        "The bearing loss hardly changes with the rotor skew angle.\n",
        "data.quantify-claims",
    )
    assert not has(however, rid), "connective.avoid defaults to none"


def test_ieee_caption_opening_and_caption_scope_vocabulary():
    def fig(c):
        return f"\\begin{{figure}}\n\\caption{{{c}}}\n\\end{{figure}}\n"

    assert has(fig("The measured noise versus speed."), "ieee.caption-opening", FULL)
    assert not has(fig("Measured noise versus speed."), "ieee.caption-opening", FULL)
    assert has(fig("Current density in the end ring."), "terms.one-canonical", FULL)
    assert not has(
        "The current density in the end ring rises with the slip here.\n",
        "terms.one-canonical",
        FULL,
    ), "caption-only term"


def test_semantic_line_breaks_two_sentences_on_one_line_is_info():
    h = next(
        x
        for x in hits("The noise rises with speed here. The torque falls with speed here.\n")
        if x["rule"] == "mech.semantic-line-breaks"
    )
    assert h["severity"] == "info"
    assert not has(
        "The noise rises with speed here.\nThe torque falls with speed here.\n",
        "mech.semantic-line-breaks",
    )


def test_cli_finds_the_profile_from_cwd_filters_by_min_and_reports_defaults(capsys, monkeypatch):
    d = _project(
        [["preset", PRESET_ID]],
        {
            "Sections/a.tex": "The noise rises with the slot opening, which excites the frame.\nThe stator, is hot in this case here.\n"
        },
    )
    code, out, _ = run_cli(["lint-prose"], d, capsys, monkeypatch)
    assert code == 1
    assert f"preset:{PRESET_ID}" in out
    assert "default used: " in out and "spelling.variant" in out
    assert "[error grammar.subject-verb-comma]" in out
    assert "sentence.relative-clause" not in out
    assert "[warn " not in run_cli(["lint-prose", "--min", "error"], d, capsys, monkeypatch)[1]
    assert run_cli(["lint-prose", "--min", "bogus"], d, capsys, monkeypatch)[0] == 2


def test_definition_site_of_replacement_is_not_flagged():
    src = "Dual three-phase machine (DTP) drives are common.\nThe dual three-phase machine runs hot.\n"
    got = [h for h in hits(src, FULL) if "DTP" in h["message"]]
    assert [h["line"] for h in got] == [2]


def test_ieee_footnote_numbers_and_display_paragraph_are_lint():
    assert has("A fact\\footnote{aside} holds.\n", "ieee.no-footnotes", FULL)
    assert not has("A fact holds.\n", "ieee.no-footnotes", FULL)
    assert not has("{\\footnotesize A fact holds.}\n", "ieee.no-footnotes", FULL)
    assert has("The ratio is .25 here.\n", "ieee.numbers", FULL)
    assert has("The speed rises from 5-50 r/min.\n", "ieee.numbers", FULL)
    assert not has("The ratio is 0.25 from 5 to 50 here.\n", "ieee.numbers", FULL)
    detached = "\\begin{equation}\nP = k B^2\n\\end{equation}\n\nwhere k is a constant.\n"
    attached = "\\begin{equation}\nP = k B^2\n\\end{equation}\nwhere k is a constant.\n"
    assert has(detached, "equation.paragraph-after-display", FULL)
    assert not has(attached, "equation.paragraph-after-display", FULL)
    h = next(x for x in hits(detached, FULL) if x["rule"] == "equation.paragraph-after-display")
    assert "blank line" in h["message"]


def test_ieee_abstract_format_paragraphs_and_word_range():
    one = "\\section*{Abstract}\nShort abstract sentence one.\nShort abstract sentence two.\n"
    two = (
        "\\section*{Abstract}\nFirst paragraph sentence here.\n\nSecond paragraph sentence here.\n"
    )
    rules = [x["message"] for x in hits(one, FULL) if x["rule"] == "ieee.abstract-format"]
    assert any("words" in m for m in rules)  # 8 words < 150
    assert any(
        "paragraph" in x["message"] for x in hits(two, FULL) if x["rule"] == "ieee.abstract-format"
    )
    assert not has(one, "ieee.abstract-format", COMMON)


def test_ieee_abbreviation_used_before_its_definition():
    src = (
        "\\section{Introduction}\nThe VSD splits the currents.\n"
        "Vector space decomposition (VSD) maps the phases.\nThe VSD planes are orthogonal.\n"
    )
    got = [x for x in hits(src, FULL) if x["rule"] == "ieee.abbreviations"]
    assert [x["line"] for x in got] == [2] and "VSD" in got[0]["message"]

def test_empty_announcement_warns_content_sentences_do_not():
    rid = "sentence.no-empty-announcement"
    assert has("The state of the art is reviewed.\n", rid)
    assert has("The state of the art is reviewed, including aluminium windings.\n", rid)
    assert has("Their applications in aerospace are briefly discussed.\n", rid)
    assert not has("The tool is then introduced to handle connection constraints.\n", rid)
    assert not has("Insulation is verified by surge and hipot tests.\n", rid)
    assert not has("The state of the art now includes aluminium windings.\n", rid)

