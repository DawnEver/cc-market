---
name: field-reading
description: Learn how a research field writes before drafting in it - read a wide sample of the field's published papers and record their section moves, sentence templates, conventions, habits and review criteria as a field knowledge source. Use before the first draft of any paper, thesis chapter or proposal in a field with no source in knowledge/fields/, when switching field, or when the user asks to "learn how papers in this field are written", "read the literature for writing style" (including the same requests in Chinese).
---

# field-reading

Each field writes its own way: what an abstract states, how strongly a gap is claimed, where numbers sit. Common rules
govern sentences; a field source records the field's moves, templates and conventions, and never relaxes a common
rule. Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`skills/_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

1. **Existing source.** List `knowledge/fields/`. A matching field is the starting point; skip to step 5 when it
   covers the venue. Venue format requirements go to `knowledge/venues/<venue>/`, not the field.
2. **Corpus.** Full texts, not abstracts. If a literature review exists, its
   `literature-review/ongoing/<slug>/reading/*.txt` files are the texts and `*_card.md` the metadata; otherwise run
   the `literature-review` skill or ask the author for a folder of PDFs (`pdftotext -layout` into a new empty
   directory). At least 20 papers, 5 from the target venue, 5 highly cited; below that mark conclusions tentative. Fan
   out by section or sub-field above about 30 papers; each reader lands its notes as it finishes.
3. **Extract**, with counts ("17/24 papers"): moves per section; 25-40 sentence templates with `[slots]` grouped by
   move (no run of more than six words from one paper); conventions (verbs, tense, hedging, gap statements, where
   numbers sit, contribution lists, references to figures and equations, abstract length), per object type; habits,
   described neutrally with their frequency and the related dimension or rule id; weak patterns (no author names) as
   review questions particular to the field.
4. **Land the source** (layout: `knowledge/fields/README.md`): `README.md` (scope, corpus, exemplary papers),
   `prose/templates/{moves,sentences}.md`, `<content>/templates/{conventions,habits}.md` per object type (prose,
   data, figure, table, equation), `<content>/criteria.tsv` (weak patterns and field review questions as
   `<abbr>.<id>` criteria, applies both, shared by both targets of the `review` skill), `prose/rules.tsv` only for real
   field requirements, optional `<content>/vocabulary/*.tsv`, optional `lens.toml` (reading-lens procedure; schema
   `knowledge/common/lens-template.toml`; its review questions are the criteria). A habit is described, not judged; it
   never becomes a rule row redefining a common id (resolve rejects that).
   Add `field <name>` to the project's `profile.tsv`, run `academia-write resolve` and fix every jurisdiction error. Add a
   test case if a new vocabulary entry or check appears.
5. **Use it.** Before drafting a section, re-read its moves and templates; the reviewer checks the moves.
