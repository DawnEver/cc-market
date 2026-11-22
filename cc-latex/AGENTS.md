# cc-latex — AGENTS.md

LaTeX writing assistant plugin: compile workflow, academic writing style, and word
counting (`texcount`) for LaTeX documents (reports, theses, papers). Three skills, one
helper script, no hooks.

## Structure

- `skills/latex/` — `latex` skill: compile workflow, figure/table placement, citations,
  and writing style. Full style rules live in `reference/writing-style.md`.
- `skills/latex/reference/style-sources.md` — rules P1-P24 drawn from published style guides
  (IEEE, Gopen and Swan, Mensh and Kording), with sources; binding by writing-style rule 39.
- `skills/latex/reference/fields/` — field writing profiles (section moves, slot templates,
  conventions) learned from published papers; field-level only, never copied sentences.
- `skills/field-reading/` — `field-reading` skill: builds a field writing profile from a
  literature corpus before drafting (writing-style rule 38).
- `skills/count-tex/` — `count-tex` skill: word counting; drives `scripts/word-count.mjs`.
- `scripts/word-count.mjs` — finds `main.tex` (root, single depth-1 subdir, or explicit
  path), runs `texcount -inc -sum -sub=section`, formats the breakdown (per section, or
  per file for chapter-style docs) + total. Single source of truth for texcount flags,
  output parsing, and the table format.
- `tests/word-count.test.mjs` — node:test suite; fixture pinned from real texcount 3.1.1
  output (both LF and CRLF).
- `scripts/lint-prose.mjs` — candidate hits for the pattern-checkable writing-style rules;
  with an English variant (rule 40: `English variant: British|American` in the project's
  `.claude/rules/*.md`, or `--english`) also flags the other variant's spellings, LaTeX code,
  bibliography and quotations excluded. Tests: `tests/lint-prose.test.mjs`.

## Standard

- The word-count output contract lives in `scripts/word-count.mjs`; `SKILL.md` must not
  restate parsing details — it only documents the CLI flags.
- Every `spawnSync` in the script passes `windowsHide: true` (cc-market invariant).
- Change the script → update tests in the same change (TDD). Run:

  ```shell
  node --test cc-latex/tests/*.test.mjs
  ```

- This plugin has no hooks, no migrations, and no state — keep it that way.
