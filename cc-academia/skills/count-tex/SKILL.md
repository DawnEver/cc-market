---
name: count-tex
description: Count words in a LaTeX project with texcount - per-section breakdown and grand total, references excluded. Use when the user asks for the document word count, per-section counts, or progress against a word-count target (e.g. "count the words", "word count", "how many words", "word count per chapter", including the same requests in Chinese).
---

# count-tex

Run `academia-write` as `uv run --project "<plugin-root>" academia-write ...` from the LaTeX project root (see
`skills/_shared/running-the-cli.md`; `<plugin-root>` comes from this skill's path).

```bash
academia-write word-count                          # current directory
academia-write word-count chapter_2 --target 8000
```

It finds `main.tex` (project root, the single `*/main.tex` beneath it, or an explicit path), runs
`texcount -inc -sum -sub=section`, and prints a per-section table plus the grand total. The bibliography is excluded:
references live in `.bib` files, so `texcount` never counts them. `--target N` adds a progress line; `--json` emits
the machine-readable shape; `--texcount "cmd"` (or `$TEXCOUNT`) overrides the command. The output contract lives in
`src/academia/check/words.py`.

## Reporting

Present results as a per-section table plus the total (`| Section | Words |`, last row
`**Total (excl. references)**`). If a target was given, state the progress and flag which sections are still stubs.

## Notes

- Per section when texcount emits `Section:` subcounts (article-style documents); chapter-style documents (`report`
  class, `\input`ed sections) fall back to one row per included file, labelled by path.
- Sums follow texcount's `Sum count`: text + headers + captions + math (inline and displayed); the rows add up to the
  grand total exactly.
- If `texcount` is missing, install it with `tlmgr install texcount` (bundled with a full TeX Live install).
