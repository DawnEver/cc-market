---
name: pdf-intake-cover-sheet
description: "Two shipped regexes matched nothing because a word boundary had collapsed into a literal backspace; the Atypon cover sheet is now the title/keyword source"
metadata:
  type: project
---

# PDF intake: the cover sheet, and two regexes that matched nothing

Found by re-verifying the reviewer-discovery workflow against two live TTE
proofs (`260903-TTE/TTE-Reg-2026-08-{2798,2978}_Proof_hi.pdf`). Commit
`798a8ad` on `main` in `cc-config/cc-market`, unpushed.

## The one worth remembering

`_AFFILIATION` and `_COVER_END` in `academia/ingest/pdf.py` each contained a
**literal backspace byte (0x08)** where a `\b` word boundary was meant — a `\b`
written outside a raw string at some point in their history, committed, and
invisible in review. Consequences, both silent:

- `_AFFILIATION` matched **no university and no laboratory at all**. The
  pattern's stems (`universit`, `laborator`) were also wrapped in a closing
  `\b`, which can never follow a stem — so even without the stray byte they
  could not match "University". Written with a closing `\w*` now.
- `_COVER_END` matched nothing, so the cover sheet's author block never ended.
  The `Additional information` heading parsed as a fifth submitting author —
  and that list is what **every conflict rule keys off**.

A test now refuses any control character in the module:
`re.findall(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", source)` must be empty. Cheap, and
the only thing that would have caught this.

## The Atypon ReX cover sheet is the better source

`select_front_matter_page()` picks the page carrying the abstract, on the
reasoning that a cover's wrapped title "should not be trusted". That is right
for choosing a *page* and wrong for the *title*:

- **2798's own first page has no title at all** — the IEEE template's
  "REPLACE THIS LINE WITH YOUR MANUSCRIPT ID NUMBER" placeholder was never
  edited, so `init` refused the file outright.
- **2978's own title was truncated** by the three-line wrap heuristic
  ("...under Varying-Speed", losing "Conditions").
- The manuscript's own `Index Terms` sit against the introduction, and 2978's
  run read the **first two sentences of the introduction as its last two
  keywords** — so every derived query searched for the wrong thing.

So `parse_cover_title()` reads upward from the `Submission ID` label, stopping
at the category line (`Regular Paper`), and `parse_cover_keywords()` reads the
one-per-line list after `Keywords`, **skipping** running heads and `Page n of m`
markers rather than stopping at them (the list spans the cover's own page
break). Both win over the manuscript page where the cover has them. The cover
pages are joined as one document (`pages[:front_matter_index]`), empty when
there is no cover so every fallback simply does not fire.

## `pdf_text` fell back only on ImportError

`contact.pdf_text` tried `paper_pdf_ingest.convert`, and on any *other*
exception returned `""` — so once the `pdf` extra was installed, a file the
layout reader could not parse became **unreadable, where it had been readable
without the extra**. It now falls through to the plain PyMuPDF reader on any
failure (and imports `pymupdf`, not the deprecated `fitz` alias).

## Still weak

`origin_countries_from` resolves a country only when the affiliation string
names one — "Nanjing University of Aeronautics and Astronautics" yields nothing,
so 2798's five authors needed `country: CN` set by hand in `sanitized.json`.
That country sets the submission's origin for the geographic preference. A
gazetteer would fix it; guessing from the name would not.
