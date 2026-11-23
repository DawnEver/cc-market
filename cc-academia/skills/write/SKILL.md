---
name: write
description: Manuscript writing in LaTeX - drafting, revising and compressing papers, theses and reports, with figures, tables, result numbers and the compile workflow, checked against the knowledge base (common, venue, field, preset, project). Use when writing or editing LaTeX documents, sections, figures or tables; when compiling with pdflatex/bibtex; or when the user corrects the writing style (e.g. "write this section", "improve the writing", "add a figure", "compile the report", "never write X").
---

# write

Writing knowledge lives in `<plugin-root>/knowledge/` on two axes.

- **Sources** (parallel, none overrides another): `common`, `venue`, `field`, `preset`, and `project` (one paper's
  facts, in `<paper>/.academia/`, never in the plugin).
- **Content types**: prose, figure, table, data, equation, reference, caption.

Five forms per content type: **rule**, **dimension** (a choice; the owning source sets the value, else "default
used"), **vocabulary**, **template**, **criterion** (a review question, shared with peer review). Schemas:
`knowledge/README.md`.

A project names its sources in `<paper>/.academia/profile.tsv` (`kind id value evidence`). Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`skills/_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

Load only what the part being edited needs (progressive disclosure):

```bash
academia-write resolve --task write --scope <part>   # one line per rule to judge + dimension values
academia-write explain <id>                          # full rule: why, good, bad, provenance, value
```

`<part>`: title, abstract, keywords, introduction, body, conclusion, caption, table, data-plot, schematic,
multi-panel. Rules checked by lint are not in the index: they reach you only as lint hits, each naming its rule
and remedy. Run `explain <id>` only for an item you are unsure how to apply. `resolve --md` is the full dump for a
human reader, not for drafting.

## Hard constraints (always apply)

1. **Author-led logic.** The author leads the logic of the parts named by dimension `process.author-led-parts`
   (listed in the index; e.g. abstract, introduction, conclusion, outline). You may propose a reasoning skeleton or flag a
   gap, missing link or misplaced step; never restructure, condense or reorder these parts yourself. A change goes to
   the author as a proposal with its reason and is applied only after approval.
2. **Approved text.** A change of meaning in text the author has approved (named in the project's `decisions.md`)
   is BLOCK, however well written.
3. **Figures need approval.** A text or term change never reaches a figure on its own: list the affected labels and
   legends and wait for approval. A figure's design is agreed before drawing; a frozen layout does not move.
4. **One item at a time.** References, figure colours, figures and compression change one item at a time: a plan
   or sketch the author approves, the `review own` chain, then the author's sign-off.
5. **Archive before deleting.** Before removing manuscript prose, equations, figures or tables, copy the deleted
   source to the project's archive with origin and date.
6. **Page budget after every edit.** Recompile and report the page count (`academia-write page-budget`, rule
   `document.page-limit`); past the limit, say so at once and offer a compensating cut. Choose the shortest wording
   that satisfies a terminology rule.
7. **Verify before replacing a citation**: a citation is replaced by another source only after the new source's
   text has been checked for that exact claim, and the claim's scope matches what the source covers; otherwise keep
   the original. Cutting references may only drop a key from a list whose claim keeps a verified source.

## Where to go

| Task | File |
|---|---|
| Write new text | `draft.md` |
| Change existing text | `revise.md` (sentence by sentence) |
| Check before reporting (lint, reviewer agent, compile, page budget) | `review own` |
| Fit the page limit | `compress.md` |
| Figures (`academia.figure`, `academia-write check-figure`) | `figure.md` |
| Tables (`academia-write lint-table`) | `table.md` |
| Result numbers (`\val{id}` registry, `academia-write check-data`) | `data.md` |
| New field | the `field-reading` skill |
| New style preset | the `style-profiling` skill |
| The user corrects the writing | the `ruling-capture` skill |
| Word counts | the `count-tex` skill |

A check that stops names its cause and the file to fix; fix that file, never bypass the check. Do not commit or
push without the author's agreement.
