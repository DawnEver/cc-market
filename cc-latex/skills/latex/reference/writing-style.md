# Academic writing style

Style rules for LaTeX prose (reports, theses, papers). Apply them when drafting or
rewriting any section.

## Core rules

1. **Fluent, concise academic English.** Prefer short, clear sentences over complex
   multi-clause constructions; if a sentence is hard to follow, split it.
2. **Plain, direct wording.** Avoid ornate or showy phrasing (e.g. "has placed X at the
   centre of", "a focal point of intense development", "remarkable", "decisive leap").
   Prefer everyday verbs and concrete nouns over abstract noun-heavy constructions.
3. **Technical precision.** Plain wording applies to general prose, not to technical
   concepts: use the correct domain term rather than a lay paraphrase (e.g. "higher slot
   fill factor and thus higher power density", not "the conductors fill the slot better";
   "hoop stress", "thermal conduction", "centrifugal load").
4. **Cohesion.** Sentences flow logically and follow a single, consistent line of
   reasoning. Use transitions (e.g. "as a result", "in parallel", "however", "to meet
   these demands") and thread each paragraph into the next, so the text reads as a
   continuous argument rather than disconnected statements.
5. **Semantic line breaks.** In the source, start a new line after each sentence (at the
   period) and after the commas that separate clauses in long sentences — roughly one
   sentence or clause per source line. This keeps diffs clean; source line breaks do not
   affect the rendered output.

## Self-check before finishing a section

- Every sentence is short enough to read aloud in one breath.
- No showy adjectives or abstract-noun piles survive.
- Each paragraph starts by linking to the previous one.
- Each sentence starts on its own source line.
