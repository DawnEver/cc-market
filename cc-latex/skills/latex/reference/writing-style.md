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
   N strands. The first strand is ... The second strand is ...". Thread each paragraph
   into the next; a heading followed by a list of categories is a symptom of this
   anti-pattern. In an introduction, the whole section should read as a single narrative
   line, not as an annotated survey.
8. **Background serves the argument.** Introduce background only where the main line
   needs it, and only in the detail the argument requires. In an introduction, do not
   expand technology overviews (e.g. process comparisons between related technologies)
   unless they are used later in the paper.
9. **Cohesion at sentence level.** Every sentence must hook onto its predecessor:
   repeat its key concept (anaphora: "these goals", "their", "both effects") or advance
   it with a causal link ("hence", "therefore", "and thus"). Never place adjacent
   sentences that merely list unrelated attributes. When a technology offers several
   properties, turn the list into a mechanism chain: "X raises A, which lowers B and
   hence improves C" — one step per sentence, each step caused by the previous one.
10. **Semantic line breaks.** In the source, start a new line after each sentence (at the
   period) and after the commas that separate clauses in long sentences — roughly one
   sentence or clause per source line. This keeps diffs clean; source line breaks do not
   affect the rendered output.
11. **Display-equation spacing.** After a display equation, the next source line belongs
   to the same paragraph unless separated by a blank line. Keep a "where $x$ is ..." or
   "with ..." continuation attached, with no blank line; insert a blank line only when
   the following text opens a new topic. The vertical spacing of the equation itself is
   unaffected; the rule concerns paragraph boundaries only.

## Self-check before finishing a section

- Every sentence is short enough to read aloud in one breath.
- No showy adjectives or abstract-noun piles survive.
- No inert attribute lists; every sentence states a reason, a goal, or a consequence.
- No sentence bundles a parenthetical definition with its consequence; definitions get
  their own sentence.
- Trends and goals use the progressive voice ("pursuing", "aiming at"), never
  "must deliver"-style obligations.
- Every sentence hooks onto its predecessor (anaphora or causal link); no isolated
  attribute lists; properties are organized into mechanism chains.
- Each paragraph starts by linking to the previous one.
- No enumerative scaffolding ("the first strand ... the second strand ..."); the section
  advances along a single line.
- The canonical term is used throughout; no synonym substitutes.
- Each sentence starts on its own source line.
- After every display equation: no blank line before a where-style continuation, a blank
  line before a new-topic paragraph.
