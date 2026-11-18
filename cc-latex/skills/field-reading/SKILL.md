---
name: field-reading
description: Learn how a research field writes before drafting in it — read a wide sample of the field's published papers and record their section moves, sentence templates and conventions as a field writing profile. Use before the first draft of any paper, thesis chapter or proposal in a field the project has no profile for, when switching venue or field, or when the user asks to "learn how papers in this field are written", "read the literature for writing style" (including the same requests in Chinese). Required by writing-style rule 38.
---

# field-reading

Every field writes its own way: what an abstract states, how strongly a gap is
claimed, whether contributions are bulleted, how results carry numbers. The generic
rules in the `latex` skill (`reference/writing-style.md`) govern sentences; the field's
published papers govern moves, register and conventions. Rule 38 makes this step
mandatory before drafting.

## 1. Check for an existing profile

Read the profiles shipped in `../latex/reference/fields/` (one file per field) and
the project's own `.claude/field-style.md` if present. A shipped profile that matches
the field and venue is the starting point; the project profile only records what
differs for this venue or paper (step 4). Skip to step 5 when both already cover the
venue.

## 2. Assemble the corpus

Take full texts, not abstracts: the moves of an introduction and a results section
are invisible in an abstract.

- If a `cc-academia` literature review exists for the topic, its
  `literature-review/ongoing/<slug>/reading/*.txt` files are the full texts and the
  `*_card.md` files give metadata. Otherwise run `cc-academia:literature-review` first,
  or ask the user for a folder of PDFs (`pdftotext -layout` into a new empty
  directory, never into the source folder).
- Read widely: at least 20 papers, of which at least 5 come from the target venue,
  and at least 5 are highly cited or award papers as models of good writing. Below
  that size, mark every conclusion as tentative.
- Fan out by section or by sub-field when the corpus exceeds about 30 papers; each
  reader lands its notes as it finishes (no barrier).

## 3. Extract the profile

For each paper, read the abstract, the introduction, one results discussion and the
conclusion in full; skim the method. Record, with counts ("17/24 papers"):

1. **Moves per section** — the ordered rhetorical steps (e.g. context → specific
   problem → prior work → gap → this paper → findings).
2. **Sentence templates** — 25 to 40 recurring sentence types written with
   `[slots]`, grouped by move. Never copy a sentence: no run of more than six words
   from one paper (stock formulae common to many papers are conventions). A template records the structure; the wording stays the writer's.
3. **Conventions** — reporting verbs and tense, "we" versus passive, hedging strength,
   how the gap is stated, where numbers and operating points appear, how prior work
   is compared, contribution lists, figure and equation referencing, abstract length.
4. **Divergences** — every place where the field's practice differs from a rule in
   `../latex/reference/writing-style.md`, with the rule number. Report the
   divergence; do not resolve it here (step 4).
5. **Weak patterns** — habits in the corpus that the generic rules reject, without
   author names.

The shipped profiles in `../latex/reference/fields/` show the format.

## 4. Settle divergences and land the profile

A divergence goes to the user, one line each: the field's practice, the conflicting
rule, a recommendation. The user's ruling goes into the project's writing rules (the
project wins over the generic rules, as everywhere in cc-latex). Write the profile to
the project's `.claude/field-style.md` (not an auto-loaded rules file: it is long and
read on demand), and add one line to the project's writing rules pointing to it. A
profile that is field-level rather than paper-level, and built from at least 20
papers, may be proposed for `../latex/reference/fields/`; the meta-rule of
`writing-style.md` applies: templates and conventions only, no project content.

## 5. Use the profile while writing

Before drafting a section, re-read that section's moves and templates. Draft move by
move; the generic rules then shape each sentence. The `prose-reviewer` agent checks
drafted sections against the profile's moves and settled conventions.
