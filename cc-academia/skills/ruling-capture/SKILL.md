---
name: ruling-capture
description: Store a writing ruling once, in its one place in the knowledge base, with provenance, and make it checkable. Use when the author corrects the writing ("never write X", "use Y", "this figure must ...", "always ..."), including the same requests in Chinese.
---

# ruling-capture

Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`skills/_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

1. **Classify** on three axes:
   - source: language correctness or a general writing principle -> `common`; a venue's format -> `venue`; how the
     field writes -> `field`; a reusable style choice where careful writers differ -> a dimension value in the `preset`; a fact or decision of
     this paper -> `project` (`<paper>/.academia/`, never `knowledge/`);
   - content: prose, figure, table, data, equation, reference, caption;
   - form: rule (a requirement), dimension (one choice among valid options: the value goes to the owner named in
     `common/<content>/dimensions.tsv`; a new choice needs a definition there first, with every valuable option),
     vocabulary (forbidden, caution, canonical, hyphenate, spelling, allocation, collocation, phrase), template (a
     structure), criterion (a review question).
2. **Check it is new.** `academia-write resolve --md | grep -i <keyword>` (the full dump; then `academia-write explain <id>`). If it exists, tighten the existing item instead of
   adding a copy. If it contradicts another source, do not override: report the conflict to the author.
3. **Write it** in its one file with provenance (`user ruling YYYY-MM-DD (...)`, described neutrally: no unpublished
   manuscript text), a semantic id (`<area>.<what>`, never a number), and `check` = `lint:<id>` when a pattern can
   catch it.
4. **Make it checkable.** A new lint check: implement it in `src/academia/check/` (its `CHECKS` list) and add positive
   and negative synthetic test cases in `tests/check/`. A vocabulary entry: its `why` starts with the rule id; add a
   test case.
5. **Verify.** `uv run --project "<plugin-root>" pytest tests/check` and `academia-write resolve` without jurisdiction
   errors; add a row to `knowledge/MAPPING.tsv` only when it replaces an old item.
6. Report: the ruling, where it went (file:line), how it is checked.
