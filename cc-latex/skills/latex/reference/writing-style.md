# Academic writing style

Style rules for LaTeX prose (reports, theses, papers). Apply them when drafting or
rewriting any section.

## Meta-rule: skills describe principles, not project specifics

A generic skill states transferable principles only. It must not contain details of any
specific paper, project, or document: no project terminology choices, no machine or
design parameters, no section plans, no sentences lifted from a particular manuscript.
Project-specific decisions (which term is canonical for this document, which equations
the paper uses, how sections are organized) live in the project itself — its
CLAUDE.md, a project-local style guide, or the document's own comments. Examples in a
generic skill illustrate the principle; they are never instructions to apply that
content verbatim.

## Core rules

1. **Fluent, concise academic English.** Prefer short, clear sentences over complex
   multi-clause constructions; if a sentence is hard to follow, split it. Each sentence
   should carry one claim and, ideally, one causal or logical step. In particular, never
   bundle a parenthetical definition with its consequence in one sentence: when a term
   needs a definition, give the definition its own sentence and let the consequence
   follow in the next.
2. **Plain, direct wording.** Avoid ornate or showy phrasing (e.g. "has placed X at the
   centre of", "a focal point of intense development", "remarkable", "decisive leap").
   Prefer everyday verbs and concrete nouns over abstract noun-heavy constructions.
3. **Technical precision.** Plain wording applies to general prose, not to technical
   concepts: use the correct domain term rather than a lay paraphrase (e.g. "higher slot
   fill factor and thus higher power density", not "the conductors fill the slot better";
   "hoop stress", "thermal conduction", "centrifugal load").
4. **Terminology consistency.** Use one canonical term for a concept throughout the
   document, fixed at the start (e.g. in the nomenclature); never substitute synonyms
   for stylistic variety. Qualify a term only where the contrast genuinely matters, and
   then consistently.
5. **Purposeful, causal sentences.** Prefer constructions that state the reason or the
   goal. For example, write "X pursues A to achieve B", where B is the design or
   performance goal, rather than an inert enumeration of attributes ("X adopts A, B, and
   C"). Avoid sentences that merely list properties without connecting them to an
   objective.
6. **Trends are pursued, not obligated.** Describe goals and trends in the progressive
   voice ("motors are pursuing higher efficiency", "designs are aiming at lower
   losses"), never in an obligation voice ("motors must deliver higher efficiency").
   The obligation voice reads as a command and is not an academic way to state a
   trend.
7. **Progressive structure, no enumerative scaffolding.** Organize paragraphs as one
   continuous line of reasoning that advances step by step toward the gap and the
   proposed solution. Do not use "total-part" scaffolding such as "X can be grouped into
   N strands. The first strand is ... The second strand is ..." for unordered categories.
   Use numbered steps only when their order is part of the method or procedure. Thread
   each paragraph into the next; a heading followed by a list of categories is a symptom
   of this anti-pattern. In an introduction, the whole section should read as a single
   narrative line, not as an annotated survey.
8. **Background serves the argument.** Introduce background only where the main line
   needs it, and only in the detail the argument requires. In an introduction, do not
   expand technology overviews (e.g. process comparisons between related technologies)
   unless they are used later in the paper.
9. **Cross-reference without restatement.** When a definition, result, constraint, or
   derivation has already been established, cite its section, equation, figure, or table
   and state only the conclusion needed by the current argument. Do not repeat the earlier
   setup, formula, or proof unless the current section introduces a new qualification or
   changes its scope. A cross-reference should advance the reasoning rather than restart it.
10. **Cohesion at sentence level.** Every sentence must hook onto its predecessor:
   repeat its key concept (anaphora: "these goals", "their", "both effects") or advance
   it with a causal link ("hence", "therefore", "and thus"). Never place adjacent
   sentences that merely list unrelated attributes. When a technology offers several
   properties, turn the list into a mechanism chain: "X raises A, which lowers B and
   hence improves C" — one step per sentence, each step caused by the previous one.
11. **Semantic line breaks.** In the source, start a new line after each sentence (at the
   period) and after the commas that separate clauses in long sentences — roughly one
   sentence or clause per source line. This keeps diffs clean; source line breaks do not
   affect the rendered output.
12. **Display-equation spacing.** After a display equation, the next source line belongs
   to the same paragraph unless separated by a blank line. Keep a "where $x$ is ..." or
   "with ..." continuation attached, with no blank line; insert a blank line only when
   the following text opens a new topic. The vertical spacing of the equation itself is
   unaffected; the rule concerns paragraph boundaries only.
13. **Archive substantive deletions.** Before removing manuscript prose, equations,
    figures, or tables, preserve the deleted source in the project's designated archive
    with its origin and deletion date. Archiving keeps superseded reasoning available
    for later comparison without leaving it in the compiled manuscript.

14. **Tables: full names, one quantity per cell, units in brackets.** Write every parameter
    name in full; never abbreviate it ("Stator outer diameter", not "Stator OD"). Give each
    physical quantity its own row or cell; never pack two quantities into one cell with a slash
    ("Slots / poles", "264.3 / 192 mm"). Put the unit in square brackets after the name
    ("Stator outer diameter [mm]") and leave the value cell as a bare number, so that every
    dimensional entry states its unit exactly once.

15. **Detail follows position.** The abstract, the introduction and the conclusion state
    what was found and why it holds: the mechanism, the direction of an effect, and its
    relative size or validity condition. Case-specific detail stays in the results: the
    operating point, the absolute value in watts or volts, the fitted coefficient, the count
    of simulated points. Write "PWM adds a large share of the loss, and almost all of the
    magnet loss comes from PWM" in the abstract, and give "1.67 kW at 450 N·m and
    5000 r/min" in the results section. A number may appear in a general section only when
    it is itself the transferable finding (a scaling exponent, a ratio, a bound), and then
    without the operating point that produced it.

16. **Established terminology, no coined terms.** Use the term the field already uses for a
    concept (check a standard textbook or the cited papers) instead of inventing a descriptive
    phrase; e.g. "first and second carrier groups" rather than "carrier band and double-carrier
    band", "DC and AC copper loss" rather than "conductor DC and conductor AC". Keep type
    descriptors attached to the noun they qualify: a winding is of hairpin type, so write "a
    hairpin winding with two three-phase sets", not "two hairpin winding sets". Introduce a new
    term only for a genuinely new concept, define it once, and say why no existing term fits.
17. **Refer to the manuscript as "this paper".** Whatever the submission format (digest,
    extended abstract, letter), the document calls itself "this paper", never "this digest" or
    "this work" in alternation.
18. **The introduction opens general and narrows.** The first sentence states the broad
    context the reader already shares (e.g. the electrification trend and its demand on the
    machine); each following sentence narrows by one level (application, machine class,
    operating regime, problem) until the gap. Do not open on a technical specific such as an
    operating regime or a component.

19. **Write for the general practitioner; cite the textbook, explain only what the argument
    needs.** Assume a reader who knows the field broadly but not the paper's specialty. Before
    a specialty concept is used in an argument, name it with its standard reference and state,
    in one or two sentences, only the property the argument relies on. Do not re-derive or
    tutor textbook material (a standard transformation, a modulation scheme, a control
    structure): cite it. Spend explanation only on what is specific to this paper's argument,
    and order it from the familiar to the special, so that each concept rests on concepts
    already introduced. A background section that reads like a tutorial is a defect.
20. **Schematic figures are symbolic.** A schematic (circuit, control block diagram, model
    structure, flow chart) shows structure, not a case: label every quantity with its symbol
    ($V_\mathrm{dc}$, $f_c$, $\omega_r$, the set displacement as a symbol or "$\pi/6$" only when
    the angle is the defining property) and never with a numeric value of the studied case
    ("800 V", "20 kHz", "523.6 rad/s"). Leave out gains, step sizes, file names and tool
    internals; the values belong in the machine/method table or the text. Use the paper's
    terms in the figure (e.g. "winding set", not a tool's "star"). Data plots are exempt:
    their axes carry numbers.
    Explanatory notes ("one set shown", "set 2 shifted by ...") never appear inside a figure;
    they belong in the caption.

## Self-check before finishing a section

- Every sentence is short enough to read aloud in one breath.
- No showy adjectives or abstract-noun piles survive.
- No inert attribute lists; every sentence states a reason, a goal, or a consequence.
- No cross-reference restates an earlier definition, formula, proof, or setup; it carries
  forward only the conclusion needed by the current argument.
- No sentence bundles a parenthetical definition with its consequence; definitions get
  their own sentence.
- Trends and goals use the progressive voice ("pursuing", "aiming at"), never
  "must deliver"-style obligations.
- Every sentence hooks onto its predecessor (anaphora or causal link); no isolated
  attribute lists; properties are organized into mechanism chains.
- Each paragraph starts by linking to the previous one.
- Schematic figures carry symbols only: no case values, gains, file names or tool internals.
- No enumerative scaffolding ("the first strand ... the second strand ..."); the section
  advances along a single line.
- The canonical term is used throughout; no synonym substitutes.
- Each sentence starts on its own source line.
- After every display equation: no blank line before a where-style continuation, a blank
  line before a new-topic paragraph.
- Substantive deleted material has been copied to the project archive.
- Tables use full parameter names, one quantity per cell, and units in square brackets.
- The abstract, introduction and conclusion carry no operating points, absolute values or
  fitted coefficients; those stay in the results.
- Every technical term is the one the field uses; no coined phrases; type descriptors sit on
  the right noun.
- The manuscript calls itself "this paper".
- The introduction's first sentence is general and each sentence narrows by one level.
- Every specialty concept is named with its reference and its one needed property before use;
  textbook material is cited, not explained; the background runs from familiar to special.
