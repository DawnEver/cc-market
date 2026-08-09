---
name: latex
description: LaTeX writing conventions and academic writing style — compile workflow, figure/table placement, citations, prose style, semantic line breaks. Use when writing or editing LaTeX documents, chapters, sections, or figures; when running pdflatex/bibtex; or when reviewing academic prose for style (e.g. "write this section", "add a figure", "improve the writing", "compile the report").
---

# latex

Guidance for writing and editing LaTeX documents (reports, theses, papers).

## Compile workflow

After modifying the source, compile from the document directory that holds `main.tex`:

```bash
pdflatex main && bibtex main && pdflatex main && pdflatex main
```

The first pass resolves `\cite` keys, `bibtex` builds the bibliography, and the later
passes resolve references and cross-references. Re-run after any change.

## Conventions

- One document per directory; each document root has its own `main.tex`.
- Figures: `\includegraphics` — place figures and tables near the relevant discussion,
  not at the end.
- Citations: `\cite{key}` (natbib, numeric).
- Display equations: a blank line after the equation opens a new paragraph — use it only
  when the following text starts a new topic; a "where ..."-style explanation or a
  sentence continuing the equation stays attached, with no blank line.

## Writing style

Write fluent, concise academic English: short clear sentences, plain direct wording,
cohesive flow, and semantic line breaks (roughly one sentence per source line). One claim
per sentence: split any sentence that combines a definition aside with a consequence.
The full style rules with examples are in `reference/writing-style.md` — load it before
drafting or rewriting prose.

## Word counts

For per-section word counts and progress against a word-count target, use the
`count-tex` skill.
