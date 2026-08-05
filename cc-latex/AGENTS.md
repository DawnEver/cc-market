# cc-latex — AGENTS.md

LaTeX writing assistant plugin: compile workflow, academic writing style, and word
counting (`texcount`) for LaTeX documents (reports, theses, papers). Two skills, one
helper script, no hooks.

## Structure

- `skills/latex/` — `latex` skill: compile workflow, figure/table placement, citations,
  and writing style. Full style rules live in `reference/writing-style.md`.
- `skills/count-tex/` — `count-tex` skill: word counting; drives `scripts/word-count.mjs`.
- `scripts/word-count.mjs` — finds `main.tex` (root, single depth-1 subdir, or explicit
  path), runs `texcount -inc -sum -sub=section`, formats per-section table + total.
  Single source of truth for texcount flags, output parsing, and the table format.
- `tests/word-count.test.mjs` — node:test suite; fixture pinned from real texcount 3.1.1
  output (both LF and CRLF).

## Standard

- The word-count output contract lives in `scripts/word-count.mjs`; `SKILL.md` must not
  restate parsing details — it only documents the CLI flags.
- Every `spawnSync` in the script passes `windowsHide: true` (cc-market invariant).
- Change the script → update tests in the same change (TDD). Run:

  ```shell
  node --test cc-latex/tests/*.test.mjs
  ```

- This plugin has no hooks, no migrations, and no state — keep it that way.
