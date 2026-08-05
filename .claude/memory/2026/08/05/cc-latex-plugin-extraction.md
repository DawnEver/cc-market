---
name: cc-latex-plugin-extraction
description: "cc-latex plugin: LaTeX writing assistant extracted from the PEMC report_latex project"
metadata:
  type: reference
---

# cc-latex plugin extraction

On 2026-08-05, created the `cc-latex` plugin in cc-market, extracted from
`PEMC/251001-Faculty_of_Engineering/260701_Annual_Report/report_latex`
(CLAUDE.md/AGENTS.md conventions + the count_tex skill).

## What shipped

- `skills/latex/` — compile workflow (pdflatex → bibtex → pdflatex ×2),
  figure/table placement, citations, writing style (full rules in
  `reference/writing-style.md`)
- `skills/count-tex/` — word counting; drives `scripts/word-count.mjs`
- `scripts/word-count.mjs` — finds `main.tex` (root, single depth-1 subdir,
  explicit path), runs `texcount -inc -sum -sub=section`, parses the breakdown
  and the grand total (last `Sum count` line). `--target N` progress, `--json`,
  exit codes 0/1/2. No hooks, no shared/ bundling, no state.
- Tests pinned against real texcount 3.1.1 output (LF + CRLF fixture).

## Gotchas (why it is the way it is)

- **CRLF**: Windows texcount emits `\r\n`; the parser splits on `/\r?\n/`.
  The LF-only fixture hid this — caught by the real-texcount smoke test.
- **Per-unit lines are indented** — `^\s*` in the unit regex. The parenthesized
  tuple is `(#headers/#floats/#inlines/#displayed)` — only inlines+displayed
  belong in the -sum total.
- **`Sum count` includes math**: text+headers+captions+inlines+displayed. The
  trailing `Subcounts:` block's t+h+c values exclude math, so they do NOT add
  up to the grand total — the parser adds inlines+displayed so rows match.
- **Breakdown fallback**: `Section:` subcounts only appear for article-style
  docs; chapter-style docs (`report` class, `\input`ed sections — e.g. the
  year_1 report) emit none, so the parser falls back to the trailing per-file
  summary rows (`197+1+0 (1/0/0/0) Included file: ./Sections/1-abstract.tex`).
  Verified: year_1 rows (198+320+...+1546) sum to the 7733 grand total.
- The last `Sum count:` line is the whole-document total.
- `--texcount` accepts a quoted command (`node "C:\path with spaces\stub"`)
  via a mini quote-aware tokenizer — needed for OneDrive-style paths.
- main.tex discovery: root wins over depth-1 subdirs; ambiguous depth-1
  candidates error out listing them.
- Pre-commit hook plugin list is hardcoded — new plugins must be added to
  `scripts/git-hooks/pre-commit` (fanout list + loop) or their tests are
  skipped; pre-push discovers plugins generically.
- texcount's `NOTE: Package Win32::Console::ANSI…` warning goes to stderr and
  is ignored by the parser.
