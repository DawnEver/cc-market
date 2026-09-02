---
name: audit-xlsx
description: The contact-list audit workbook script, and the two eligibility rules it forced into the policy
tier: short
created: 2026-09-01
metadata:
  type: project
---

# `scripts/audit_xlsx.py`, and the two rules it exposed

`uv run --extra xlsx python scripts/audit_xlsx.py
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

- `person_id` dropped; `recommendation` → `Recommend as reviewer`;
  `filter_` prefixes stripped. The recommendation is three states —
  Recommend / Check first / Do not invite — because "meets every rule, address
  unverified" is neither a recommendation nor a rejection.
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

Venue type turned out to carry two vocabularies, which cost a whole rule:
OpenAlex states the *work* type (`article`, `review`, `conference-paper`) and
leaves the journal name in the venue, IEEE states the *venue* type (`IEEE
Journals`, `IEEE Conferences`, `Artech Books`). Matching the substring
`journal` read only the second, so every OpenAlex journal paper scored as a
non-journal. `is_journal` now reads both and `venue_type_stated` says whether
the record claims anything at all.

## The CSV has a producer now

The audit CSV was written by a script that no longer exists, so the file an
editor filtered on described a policy that had moved on and could not be
regenerated. `report` writes `contact-list-audit.csv` itself, from the same
outcomes the pipeline computed: one column group per rule that *ran*, carrying
its verdict, the numbers it compared and the thresholds it applied.

That required `RuleOutcome.facts` — the arithmetic behind the sentence — plus
`RuleOutcome.abstained`, because a rule that had no evidence passes but must not
read as a pass. Verdict vocabulary lives in `eligibility.verdict_of`:
PASS / FILTERED / VERIFY / PREFERENCE_MISSED. Thresholds are stated on every
row, including rows of candidates a conflict removed before any rule measured
them, because a threshold belongs to the run and not to a person.

## Four defects the workbook exposed

All four made a rule look like it had cleared somebody it never examined.

1. **`manuscript_authors.person_id` was never filled in.** The co-authorship,
   shared-doctorate and advisor rules all key on person ids, so all three ran
   against an empty list. Resolution happens at `coi` time (the corpus does not
   exist earlier). An ORCID identifies and blocks; a name only raises
   `possible_recent_coauthor` for the editor — three researchers publish as
   "Wei Hua".
2. **Affiliation strings were compared whole.** A manuscript gives "the School
   of Electrical Engineering, Southeast University, Nanjing 210096, China",
   which never equals a recorded employer. Compared segment by segment now;
   `same_department` needs the department named on both sides rather than merely
   present in the candidate's record.
3. **Counting rules counted the sample, not the record.** `candidate.evidence`
   is what survived the top-papers cut — a median of one paper — so a floor of
   three was unsatisfiable by construction. `Candidate.relevant_papers` carries
   the whole relevant record and the counting rules read that.
4. **`academic_age` only ever spoke when it had a complaint**, so nothing could
   verify it had run. It is a `RuleOutcome` now, abstaining where no doctorate
   year is on record.

Policy fixes that came with them: TTE no longer narrows `coauthor_years` to 4
(it was *looser* than the default, and a test now refuses a silent narrowing),
and `[seniority.career]` is `prefer` rather than a hard ten-year ceiling that
excluded 64 senior candidates and left the run with nobody to invite.

## What the tte-2026-08-2905 run says after all that

300 scored papers → 166 candidates → 143 CLEAR, 19 REVIEW, 4 BLOCK (the four
submitting authors). Ten candidates clear every rule, all ten reading
`Check first` because their address is unverified against their institution.
Out for: 121 too few related journal papers, 23 COI, 8 nothing on this topic
lately, 4 restricted country.

Findings that had never fired before: 46 `possible_recent_coauthor`, 24
`previous_institution_overlap`, 6 `same_institution`, 1 `same_department`, 1
`dense_historic_collaboration`.

**Invitation response and unresponsive veteran still abstain for everybody** —
the store holds no invitation history, and nothing has been sent. So do 123
academic-age rows, for want of a doctorate year.

## Gotchas

- Regenerating while the `.xlsx` is open in Excel fails with
  `PermissionError: [Errno 13]`.
- The suite used to write its stub people into `~/cc-academia-facts/`:
  `ACADEMIA_FACTS_SYNC` lives in a shell profile, pytest inherits it, and with
  no data root above a temporary directory `facts_dir()` fell back to home.
  Those facts merged back in on the next run and renamed a stubbed expert,
  which is what the long-standing `test_pipeline_e2e` failure actually was —
  not the diacritic in the name. Export resolves separately now
  (`export_facts_dir`), and `conftest` isolates the folder regardless.
- Dossier cleanup globbed `[0-9][0-9]-person-*.md`, so a run with more than 99
  candidates left every later dossier for the next run to present as its own.
