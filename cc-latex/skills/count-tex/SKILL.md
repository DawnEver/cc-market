---
name: count-tex
description: Count words in a LaTeX project with texcount — per-section breakdown and grand total, references excluded. Use when the user asks for the document word count, per-section counts, or progress against a word-count target (e.g. "统计字数", "word count", "how many words", "字数分章节统计").
---

# count-tex

Run the plugin's `word-count.mjs` script from the project:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs               # current directory
node ${CLAUDE_PLUGIN_ROOT}/scripts/word-count.mjs chapter_2 --target 8000
```

It finds `main.tex` (project root, the single `*/main.tex` beneath it, or an explicit
path), runs `texcount -inc -sum -sub=section`, and prints a per-section table plus the
grand total. The bibliography is excluded automatically: references live in `.bib` files,
so `texcount` never counts them. `--target N` adds a progress line against the
word-count target (e.g. one stated in the project's `AGENTS.md`/`CLAUDE.md`).

## Reporting

Present results as a per-section table plus the total, for example:

| Section | Words |
|---|---:|
| Abstract | 42 |
| Aim & Objectives | 320 |
| Background | 682 |
| … | … |
| **Total (excl. references)** | **1064** |

If a target was given, state the progress and flag which sections are still stubs.

## Notes

- `-inc` follows `\input`; `-sum` merges text + headers + captions; `-sub=section` gives
  per-section subcounts.
- If `texcount` is missing, install it with `tlmgr install texcount` (it is bundled with
  a full TeX Live / `pdflatex` install).
