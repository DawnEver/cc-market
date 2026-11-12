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
18. **Abstract, introduction and conclusion open general and narrow.** The first sentence of
    each states the broad context the reader already shares (e.g. the electrification trend
    and its demand on the machine); each following sentence narrows by one level
    (application, machine class, operating regime, problem) until the gap, then states what
    the paper does, what it finds and why it matters. Never open on a technical specific
    such as a converter detail, an operating regime or a component. In the abstract,
    describe a specialty concept by its role in plain words before, or instead of, its
    symbol or name; one sentence carries one step, never a chain packed with semicolons.
    The conclusion opens with the question the paper answered, not with a result detail.

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
21. **Figures follow the text and are laid out cleanly.** A change of a term, a symbol, a
    label or a claim in the text is carried into every figure, axis label, legend and
    caption that shows it, in the same edit; a figure never keeps a label the text has
    dropped. Panels of one figure share a baseline and a common height, use one font size
    and one colour scheme, and keep their tick labels and legends legible at print size;
    check the compiled page, not only the source, before finishing.
    Use the page width: do not leave a single half-width panel alone on a row when a related
    panel can share it; pair related panels or widen the plot.
22. **Natural sentences, concrete subjects.** Do not nest clauses such as "a simulation in which
    ... so that ..."; split them into independent sentences. Do not open a sentence with a noun
    clause ("How the ripple divides ... is set by ...", "What has not been shown is ..."); give
    the sentence a concrete subject (a quantity, a component, the authors' study). Name the
    physical cause: write "the ripple current depends on the high-frequency inductance", not
    "the machine itself sets the ripple current". Replace metaphors ("a second path for the
    ripple") with the established term. Every sentence must follow from the one before; if a
    reader cannot say why it comes next, add the missing link.
23. **Let the contribution show through the work.** Do not announce novelty ("Its novelty is
    ..., not ...") or label the paper's own work with an ill-fitting abstract noun
    ("attribution"); state what the paper does and finds, in the order it does it, and let
    the increment over the cited work follow from that. Describe a background section by
    what it does ("outlines", "reviews"), not "develops", unless it derives new results.
    Name the application (e.g. heavy-duty traction) in the paper's statement of purpose.
24. **The roadmap is one sentence per section.** Close the introduction with the purpose
    statement followed by the section roadmap in one paragraph; give each section one sentence
    that states its role in the argument, not its findings, and do not repeat what the purpose
    statement or the contribution sentences already say. Results belong to the abstract, the
    results section and the conclusion.
25. **Sections run as one line of reasoning.** Start a section with its first substantive fact,
    linked to what the reader already knows; never preview its structure ("in four steps",
    "the later sections test", "as discussed below"), since the roadmap lives only at the end
    of the introduction. Do not write a bare assertion sentence ("An inverter imposes voltage,
    not current."): fold the fact into the causal sentence it supports. Do not open with an
    abstract umbrella sentence ("Each component is produced by the quantity that acts on it");
    name the concrete quantities directly. Never define a quantity circularly (defining the
    inductance as flux over current and then stating that current equals flux over
    inductance). Close a section with one causal sentence drawn from its facts, not with a
    list of expectations or "levers".
26. **Technical verbs, not personified or spoken ones.** Physical quantities do not see, feed,
    decide, go, or link: write "is limited by the leakage inductance", not "sees the leakage
    inductance"; "couples the stator to the rotor through the air-gap field", not "links the
    rotor"; "determines", not "decides"; "contributes to", not "feeds". Avoid spoken phrases
    ("where the ripple can go", "case by case", "has even moved", "well documented") and vague
    "there" / "this split" / "these studies"; name the plane, quantity or works. Do not start
    consecutive sentences with the same pronoun ("Its ... Its ... Its"). Generalise a single
    study's finding only as that study's finding ("a comparative study found ...").
27. **Paragraph break after a display equation.** When the text after a displayed equation
    starts a new idea (applying or interpreting the equation), leave a blank line so it opens a
    new paragraph; only a direct continuation ("where ...") follows without a blank line.
28. **Loss components from physics.** Introduce loss components by their physical cause (the
    conductor current produces copper loss, the alternating flux density in laminations produces
    iron loss, the field reaching conductive magnets induces magnet eddy currents), not as a
    bare list; a split into fundamental and switching-frequency parts follows from the two
    sources in the current and field, not from an analysis purpose ("to separate").
29. **No trailing relative or participle tails.** Do not hang a ", which ..." / ", whose ..."
    clause or a ", computed ..." participle on the end of a sentence, and do not invert object
    and agent ("the impedance, which eddy currents modify"). Give the added fact its own
    sentence with its real subject ("Eddy currents in the laminations change this impedance.").
30. **Data-figure template.** Use linear axes unless a log axis is unavoidable. End each y-axis just
    above its tallest data (a few percent headroom, no empty band). Stacked panels share the x-axis
    with a small pad before zero. Put per-panel labels in a top corner, wrapped onto two lines, and
    put the legend inside the plot area (first panel or an empty region), not in a row above it.
    Mark characteristic positions (e.g. f_c, 2f_c) as symbols on the top axis with light-grey dashed
    guide lines behind the data through all panels. Paired panels share width, font size and height;
    colours and fonts come from one style block in the figure script.
31. **No relative clauses on nouns; human actions only for humans.** Do not attach a "that ..." /
    "which ..." / "who ..." clause to a noun, with or without a comma ("machines that stay
    efficient", "losses that computations omit", "comparisons that change one property"). Use an
    adjective or prepositional phrase ("machines with high efficiency") or give the fact its own
    sentence. Machines, methods, planes and quantities do not meet needs, pursue goals, need,
    seek, help or carry intentions: state the physical action ("split the current", "lower the
    current of each inverter", "are designed for higher efficiency"). Rules 26 and 29 name
    examples; this rule names the pattern, and every newly drafted or rewritten sentence is
    checked against it, abstracts and conclusions included.

32. **Order of revision and paragraph re-read.** The rules have four levels, and a higher level wins:
    L1 argument (each sentence follows from the previous; broad to narrow; causal close: rules 16, 22,
    25), L2 position (detail follows position, no previews or umbrella openers: rules 15, 24, 25),
    L3 sentence (one claim per sentence, no noun clauses as subjects, no relative tails or relative
    clauses on nouns: rules 22, 29, 31), L4 wording (technical verbs, established terms, one name per
    concept: rules 17, 18, 21, 26). To rewrite a paragraph, first write its chain of reasoning as a
    skeleton, then the sentences. After any split, merge or deletion, re-read the paragraph from its
    first sentence and check that each sentence opens with a link to the one before (connective or
    back-reference); restore a lost link instead of trading L1 for L3 or L4.

33. **Sentence variety serves the chain of reasoning.** The logical link between sentences comes
    first (rule 32); sentence form serves it. Mix sentence forms: subject-first sentences, sentences
    opened by a phrase, short and long sentences. An opening phrase ("As a result,", "In contrast,",
    "For this reason,") is used where it carries the link; a decorative opener that only adds a comma
    ("In the steady state,", "Grouped by m,", "For each plane,") is not. Do not open two consecutive
    sentences with a phrase and a comma, and avoid more than about one such opening in three sentences.
    Do not use "whereas": give each side of a contrast its own sentence and mark the contrast in the
    second ("The magnet loss, in contrast, ...").

34. **Every prose edit passes a fixed review chain before it is reported.** (1) The writer (main
    session or subagent) edits and keeps a change log: old sentence, new sentence, rule. (2)
    `scripts/lint-prose.mjs` runs on the changed files; every hit is fixed or dismissed with a reason.
    (3) The `prose-reviewer` agent, never the writer, reviews the diff cold: links first (pass 1), then
    sentence patterns (pass 2), then consistency with figures and captions. (4) The main session
    re-reads every changed paragraph and resolves each FIX; a BLOCK (meaning change to user-approved
    text) goes to the user. (5) Only then compile, inspect the page and report. A new user rule is
    added in the same pass to the project's writing rules, which the reviewer applies; a generic rule
    a pattern can catch is also added to the lint.

## Self-check before finishing a section

- Read the opening words of consecutive sentences in each paragraph: no two phrase-plus-comma openings in a
  row, no decorative opener, no "whereas" (rule 33).

- Two passes, in this order. Pass 1 (L1): read each paragraph from start to end and check every link
  between consecutive sentences. Pass 2 (L3-L4): search the sentences for the patterns of rules 26,
  29 and 31.

- Search the new text for " that ", " which ", " who " and for personal verbs (meet, need, pursue,
  seek, help, allow, enable, see, feed, decide); each hit is either a pronoun ("that of") or is
  rewritten (rule 31).

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
- Every text change is mirrored in the figures; panels share a baseline and height, and the
  compiled page has been inspected.
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
- No nested in-which/so-that clauses, no noun-clause subjects, no vague causal subjects or metaphors;
  no announced novelty; every sentence follows from its predecessor.
- The roadmap gives one sentence per section, states roles not findings, and repeats nothing.
- No section previews its own structure; no bare assertions, umbrella openers or circular
  definitions; each section closes with a causal sentence, not a list.
- The first sentence of the abstract, the introduction and the conclusion is general, and each
  following sentence narrows by one level; no specialty symbol appears in the abstract before its
  role is stated in plain words.
- Every specialty concept is named with its reference and its one needed property before use;
  textbook material is cited, not explained; the background runs from familiar to special.
- The review chain of rule 34 has run: lint hits resolved, `prose-reviewer` verdict obtained from an
  agent other than the writer, every changed paragraph re-read whole.
