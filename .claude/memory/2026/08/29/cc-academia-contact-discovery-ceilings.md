---
name: cc-academia-contact-discovery-ceilings
description: "Measured limits of reviewer email/rank discovery, the URL-not-value design rule, and three parsed-then-dropped store bugs"
metadata:
  type: project
---

# cc-academia: what can and cannot be discovered automatically

Findings from wiring reviewer-discovery end-to-end against a live IEEE TTE
submission (axial-flux PM machine noise). Branch `fix/cc-academia-ci`, 6 commits,
**unpushed**.

## Contact discovery ceilings — measured, do not re-attempt

Each of these was probed live against stored papers in this field
(IEEE / MDPI / IET electrical engineering). They are dead ends **for this
literature**, not bugs to fix:

| Source | Result |
|---|---|
| Publisher OA landing page | `403` for IEEE, MDPI, IET. Springer works. |
| Open-access PDF | `403` MDPI, `502` IEEE |
| Repository copy (arXiv/institutional) | **0 available** across 24 sampled DOIs |
| Crossref author metadata | **0 addresses in 8 records** |
| Public ORCID `email` | works — most of the automatic yield |
| ORCID `researcher-urls` → staff page | works, but few researchers list a URL |

**Automatic email discovery tops out near 20% here.** That is a property of the
data. An earlier "landing pages work, 7/12" result was a biased sample — all
Springer papers left in the shared DB from unrelated work.

Live outcome: 0 → 14 of 47 candidates, and 0 → 20 with an academic position,
using ORCID plus agent-supplied staff-page URLs.

## The division-of-labour rule

The CLI has no search tool and no business guessing. So:

    rev-disc contacts --slug X    # worklist: who needs email and/or position
    rev-disc enrich --homepages f.json   # answers come back

**Hand back the URL, never the address or the rank** — even when a search
snippet displays the value. The CLI fetches the page and extracts, so
"found, never generated" survives having a model in the loop, and a stale
snippet cannot become an invitation. A supplied rank requires `rank_source`;
an unrecognised rank stops the run rather than vanishing.

## Rank: regex-over-HTML was tried and removed

Anchoring a text window on the person's name and reading what follows gave
`msc_student` for an associate professor (his page mentions supervising graduate
students) and `unknown` for a full professor (title stated *above* the name).
**A confidently wrong rank is worse than a blank one** — an editor acts on it and
skips a good reviewer without ever seeing why. Removed deliberately; the
reasoning is in `seniority.py`'s module docstring so nobody rebuilds it.

A *supplied* rank overrides the career record outright rather than competing on
seniority, otherwise a PhD candidate whose only ORCID employment is an industry
post reads as "Engineer" (this happened live, to a top-10 candidate).

## Three bugs of one shape: parsed, then dropped at the store boundary

Worth pattern-matching for elsewhere in this codebase — each was invisible
because the parse looked correct:

1. **ORCID `role-title`** — `store_institution_for` had no `role` parameter and
   the affiliations upsert's `ON CONFLICT` never updated `role`. OpenAlex writes
   each affiliation first without one; ORCID's arrived second and was discarded.
   **0 of 752** stored affiliations had a role.
2. **Person topics** lived only on the in-memory `Person`, so `coi` and `report`
   — separate commands that reload every candidate — always saw an empty list.
   Combined with FTS5 phrase-only matching, topic + method (**60% of the ranking
   weight**) scored `0.00` for every candidate.
3. **`Paper.pdf_url` / `landing_page_url`** parsed from OpenAlex with no column
   to hold them.

## Two upstream/format traps

- **`paper_pdf_ingest` exports no `ingest` function.** The real API is
  `convert` → `split_sections` → `write_paper_output`. manuscript-review ingest
  could never have worked.
- **Atypon ReX cover sheets break both workflows.** reviewer-discovery took the
  cover's wrapped first line as the title and found no abstract (the paper's
  front matter is on page 4); manuscript-review decomposed the cover into
  "Authors / Additional Information / Files for Peer Review". Both now locate the
  page carrying the abstract first.

## CI

cc-market has **no root `pyproject.toml`** — it is a multi-plugin repo. The
cc-academia job ran `uv` from the repo root, so every uv step failed with
``No `pyproject.toml` found in current directory or any parent directory``. Red
since the workflow landed. Fixed with `defaults: run: working-directory:
cc-academia` (commit `e7cf35b`, unpushed).

## Validation

506 tests pass, ruff clean, and the full CI job was run locally from
`cc-academia/` including `--no-install-package paper-pdf-ingest`, which exercises
the optional-extra guards.
