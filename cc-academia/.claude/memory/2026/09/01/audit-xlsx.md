---
name: audit-xlsx
description: The contact-list audit workbook script, and the two eligibility rules it forced into the policy
tier: short
created: 2026-09-01
metadata:
  type: project
---

# `scripts/audit_xlsx.py`, and the two rules it exposed

Uncommitted. `uv run --extra xlsx python scripts/audit_xlsx.py
<workspace>/ongoing/<slug>/5-shortlist/contact-list-audit.csv` writes `.xlsx`
beside the input — code here, output in the case workspace. `openpyxl` is
declared as the optional `xlsx` extra; nothing in the pipeline itself writes a
spreadsheet.

It first lived in the `reviewer-discovery` data workspace, which was wrong:
that repo's `AGENTS.md` says the executable workflow ships in this plugin. Moved
here, renamed to house snake_case, and this memory entry moved with it.

## Why three sheets

The CSV is 63 columns, of which 8 are conclusions and ~54 are the arithmetic
behind them. A reader who does not know the pipeline cannot tell which column to
filter on. So: **`decision`** (15 cols, opens first), **`audit`** (52 cols, every
input that varies per person), **`columns`** (how to read it, a line per column,
then the thresholds pulled out of the sheets).

## Decisions worth not re-litigating

The user drove all of these, several by rejecting an earlier attempt.

- `person_id` dropped; `selected_for_contact` → `Recommend as reviewer`;
  `filter_` prefixes stripped.
- **`Why not recommended` is derived by the script, not in the CSV** — the first
  failed check in a fixed precedence order (COI → restricted country →
  related-journal → activity → doctoral → invitation response → veteran),
  rendered as a sentence, never a field name.
- **Constant threshold columns are removed and rendered into the column labels**,
  read from the CSV at runtime via `str.format_map`, never hardcoded. A missing
  or non-constant threshold is a hard error (`THRESHOLDS_EXPECTED`) so a label
  can never show a raw placeholder.
- **No internal field names anywhere in the workbook.** Snake_case headers, a
  `CSV field` glossary column and header comments carrying them were each
  rejected in turn. Headers are plain-English quantified rules:
  `Rule: related journal papers ≥ 3`, `Rule: not working in India (IN) or Iran
  (IR)`.
- **A quantifiable rule shows its number, not a verdict word** (`RULE_MEASURES`).
  The cell holds the count or rate; the heading holds the threshold.
- **Colour comes from the verdict, never from comparing the number to the
  threshold.** This matters: 16 people show an amber `0` under
  `Rule: ≥ 1 paper in the last 3 years` because that rule is `prefer` — colouring
  by the number would have shown a red 0 and implied an exclusion that never
  happened. The verdict is kept in a shadow array purely to drive the fill.
  Words remain where there is nothing to count or nothing was measured:
  Pass / Fail / No evidence / Below preference.
- Rates render as percentages (`0.5` → `50%`).
- Header fill: white for Rank / Reviewer / Email / Institution, grey elsewhere.
  Dimension blocks separated by a **full-height vertical rule**, not colour —
  per-dimension tinting was rejected.
- Freeze `A2` only. Freezing the name columns was rejected: the sheet's job is
  fitting the dimensions side by side.
- Column widths ignore the heading (it wraps) and size to the data, 8–24.

## The two rules this exposed, now in the plugin

The `related journal papers ≥ 3` floor and the restricted-country list were
applied ad hoc by whatever produced the audit CSV — **neither existed in
`coi.toml`, `tte.toml` or `src/`**, and between them they excluded 154 of the
158 rejected candidates. So they are now first-class:

- `[geo.restricted]` — `mode` + `countries`, off and empty by default. A
  switched-on rule with an empty list, or a code that is not two letters, is
  refused in `_validate_restricted_countries` at load time. Unknown affiliation
  country → kept and `manual_review`, never guessed. TTE: `["IN", "IR"]`.
- `[activity.related_journals]` — counted over the *evidence* that qualified the
  candidate, so it asks "journal work on this topic", not "how much do they
  publish". `Evidence` gained `venue` / `venue_type`. A paper with no stated
  venue type is reported, not counted; somebody who would clear the floor if
  only those were resolved goes to `manual_review` rather than failing. TTE: 3.

Venue type is matched on the substring `journal` because sources spell it
`Journal`, `journal-article`, `Journals`, `JournalArticle`.

## What the tte-2026-08-2905 run actually says

160 candidates, 2 recommended. Blocked by: 149 too few related-journal papers,
5 restricted country, 4 COI (all `manuscript_author`).

**The invitation-response and unresponsive-veteran rules are `No evidence` for
everybody** — the store holds no invitation history, so both abstain by design.
Only three dimensions did real work. Also suspicious and unresolved: across 160
topically-close candidates, *no* COI rule other than `manuscript_author` fired —
no `recent_coauthor`, no `same_institution`. Worth verifying the collaboration
data ever reached the COI engine.

Note too that TTE narrows `coauthor_years` to 4 from the default 5, which makes
it **looser** than the default policy, and that `run-state.md` describes a
21-candidate run while this CSV has 160 — they are different runs.

## Gotchas

- Regenerating while the `.xlsx` is open in Excel fails with
  `PermissionError: [Errno 13]`.
- `tests/test_pipeline_e2e.py::test_full_pipeline_produces_an_evidenced_shortlist`
  fails on a name with a diacritic. Pre-existing, verified by stashing; not
  caused by the rule work.
