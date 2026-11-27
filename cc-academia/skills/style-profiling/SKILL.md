---
name: style-profiling
description: Record a writer's reusable style choices as a style preset (dimension values with evidence and recommended phrases) from text the writer approved and from the writer's rulings. Use when a new writer starts with the plugin, or when the user asks to "learn my writing style", "build my style preset", "build my author profile" (including the same requests in Chinese).
---

# style-profiling

Extract one writer's choices into `<plugin-root>/knowledge/presets/<name>/` (name: lower-case, hyphenated, e.g.
`jane-doe`). Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`skills/_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

A preset holds only dimension values (`<content>/values.tsv`) and recommended phrases (`phrase` vocabulary, never
flagged). `academia-write resolve` rejects anything else in a preset and names where it belongs.

1. **Corpus.** Only approved text (the writer says which); note the file and approval date. Mechanical slips are not
   style: a stray comma between subject and verb, missing hyphens in compound modifiers, unit spacing, broken fixed
   phrases, agreement errors. Run `academia-write lint-prose` on the corpus first and exclude every error-level hit.
2. **Unpublished text is never quoted** in the knowledge base (`knowledge/README.md`, Unpublished text). Evidence is a
   dated user ruling described neutrally; an example drawn from unpublished text is a paraphrase in another technical
   setting with invented numbers, marked `paraphrase; original withheld until publication`.
3. **Dimension values.** For each dimension in `knowledge/common/*/dimensions.tsv` whose owner is `preset`, find the
   writer's value. A value without evidence stays unset (the default applies and every report says "default used").
   Write `<content>/values.tsv` (`id value evidence`) for prose, figure and table alike.
4. **A choice that is no dimension yet.** If careful writers differ on it, propose a new dimension in common (options
   that keep every valid practice) and set the writer's value; if it is general practice, propose a common rule; if it
   belongs to one paper, it goes to the project (`<paper>/.academia/`). Never write a rule, criterion or template into
   a preset.
5. **Phrase bank.** Recurring phrasing as `phrase` vocabulary with placeholders (`when` = its role; source `preset`).
6. Add `preset <name>` to the project profile, run `academia-write resolve`, fix every jurisdiction error, and run
   `academia-write lint-prose` on the corpus: it must not flag the writer's chosen patterns. Add a synthetic test case
   for each new pattern (never a corpus sentence).
