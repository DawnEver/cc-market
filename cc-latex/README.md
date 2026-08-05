# cc-latex

LaTeX writing assistant — compile workflow, academic writing style, and word counting
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
| `cc-latex:count-tex` | Word counts per section plus grand total via `texcount` — references excluded; compare against a target (e.g. `--target 8000`) |

## count-tex example

```shell
node "${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs"          # current dir
node "${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs" chapter_2 --target 8000
```

Finds `main.tex` (project root, the single `*/main.tex` beneath it, or an explicit
path), runs `texcount -inc -sum -sub=section`, and prints a per-section table plus the
grand total. `texcount` ships with TeX Live (`tlmgr install texcount` if missing).

## Development

```shell
node --test cc-latex/tests/*.test.mjs
```

See `AGENTS.md` for structure and conventions.
