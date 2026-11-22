# cc-latex

LaTeX writing assistant — compile workflow, academic writing style, and field-reading before drafting, and word counting
for LaTeX documents (reports, theses, papers). No hooks; works on both Claude Code and
Codex (skills only, one helper script).

## Install

```shell
/plugin install cc-latex@cc-market
```

## Skills

| Skill | What it does |
|---|---|
| `cc-latex:latex` | LaTeX writing conventions: `pdflatex`/`bibtex` compile workflow, figure/table placement, citations, and academic writing style (concise plain English, cohesion, semantic line breaks) |
| `cc-latex:field-reading` | Before drafting in a new field or venue: read a wide sample of the field's papers and record its section moves, sentence templates and conventions as a field writing profile (rule 38); shipped profiles in `skills/latex/reference/fields/` |
| `cc-latex:count-tex` | Word counts per section plus grand total via `texcount` — references excluded; compare against a target (e.g. `--target 8000`) |

## count-tex example

```shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs"          # current dir
node "${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs" chapter_2 --target 8000
```

Finds `main.tex` (project root, the single `*/main.tex` beneath it, or an explicit
path), runs `texcount -inc -sum -sub=section`, and prints a per-section table plus the
grand total. `texcount` ships with TeX Live (`tlmgr install texcount` if missing).

## English variant

A project selects British or American spelling with one line in its writing rules
(`.claude/rules/writing.md`): `English variant: British`. Without it no variant is enforced.
`scripts/lint-prose.mjs` then flags the other variant's spellings (writing-style rule 40);
`--english british|american` overrides the project setting.

## Relaxing lint hits per project

A project whose writing rules relax a generic rule (writing-style rule 41, e.g. allowing
", which" clauses) adds `lint-prose off: 29-tail` (comma-separated hit ids) to the same rules
file; `lint-prose.mjs` then drops those hits. `--off id,id` overrides the project line.

## Abstract, introduction, conclusion (rules 42-46)

The abstract states each finding before its studied-case value (rule 42); a digest or extended
abstract need not repeat the abstract in its introduction (rule 43); divisions of a quantity are
written "allocation" or "distribution" (rule 44, lint id `44-allocation`); AI proposes, never
applies, changes to the logic of the abstract, introduction, conclusion and outline (rule 45); the
conclusion says "This paper has ..." (rule 46, lint id `46-tense`). Silence a lint id per project
with `lint-prose off:`.

## Development

```shell
node --test cc-latex/tests/*.test.mjs
```

See `AGENTS.md` for structure and conventions.
