---
name: reviewer-six-rules
description: "Reviewer eligibility is six rules over one derived record; what was deleted (answered invitations, geo.bonus, a duplicate identity threshold) and why"
metadata:
  type: project
---

# The reviewer rule surface, after the 2026-09-03 rebuild

**Supersedes `2026/08/30/reviewer-eligibility-gate.md`** for anything about
invitation responsiveness. That entry describes `invitation_response` and
`unresponsive_veteran` as live rules; both are gone. Its account of *why*
activity must be read from the publication profile rather than the local store
is still correct and is now enforced structurally (see below).

Commits on `main` in the **source** checkout
`cc-config/cc-market` — oldest first: `cad7509`, `798a8ad`, `acde754`,
`6ebb571`, `2546a4b`, `8171373`, `7970949`, `8831d9f`. Unpushed.

## Six rules, one registry, one record

`eligibility.RULES` is the whole surface and the list is closed:
`restricted_country`, `related_journals`, `relevant_activity`,
`recent_activity`, `doctoral_year`, `seniority`. Every rule is
`(CandidateRecord, Constraint) -> RuleOutcome`; `policy.constraint(<rule name>)`
resolves its table via `policy.RULE_TABLES`. Nothing outside the module may add
a seventh — a test asserts every rule name has a dimension, a heading, a
glossary entry and a blocking reason.

`reviewer/record.py` derives every quantity **once**: `PublicationRecord`
(profile before harvest, `source` recorded), `RelevantRecord` (this run's
corpus — the only thing that can say what is relevant to *this* submission),
`Seniority` (doctorate year preferred, first publication as fallback, basis
reported). Gaps stay `None`; a rule handed `None` abstains.

## Why it was rebuilt — the evidence, not the theory

Career length was derived **twice**: the old `_career` read
`repo.publication_years` (this run's harvest) and `_veteran` read
`works_by_year` (the person's own profile). On `tte-2026-08-2978` the two
disagreed for **158 of 197** candidates, by up to 28 years, in *adjacent
columns of the delivered spreadsheet*. Worse, the harvest-reading one was the
**preference for early-career reviewers**, so Deqiang He — 32 years published —
collected the early-career bonus because the search had only found his recent
papers. The rule was measuring recall, not the person.

Three further structural defects found in the same walk:

1. **Three rules were assembled by their caller.** `rank` appended
   `relevant_activity`, `academic_age` and `related_journals` *after*
   `assess()` had set `Assessment.score` as a plain field — so a `prefer` rule
   added there fed nothing into the component it exists to feed. `score` is a
   property now, and an abstention is excluded from its denominator (an
   abstention is the absence of a measurement, not a met preference).
2. **`academic_age` and `career_length` were one axis.** A floor in years since
   the doctorate beside a ceiling in years of publishing, coinciding whenever a
   doctorate year was stated. Merged into `seniority`. **The floor obeys the
   mode; the ceiling can never exclude, enforced in the rule rather than
   trusted to config** — a `require` ceiling had already emptied a live
   shortlist of every senior name in it.
3. **Fact names crossed their rules.** Rule `recent_activity` emitted
   `activity_*` while `recent_relevant_activity` emitted `recent_*`, so the
   workbook's hand-kept prefix table filed invitation counts under topic
   activity. Facts are now `<rule>_<fact>` and `dimension_of()` reads the rule
   off the column name.

## What was deleted, at the user's direction

- **Everything that judged whether an invitation was answered.**
  `invitation_response` (windowed rate) and `unresponsive_veteran`
  (long-career-plus-silence) asked one question on two windows, so they agreed
  by construction; on any store without a long invitation history both
  abstained, which is every store so far. The `reviewer_history` score
  component went with them, its **0.05 folded into `topic` (0.35 → 0.40)** —
  no ranking moved, because it returned a neutral 0.5 for anyone with no
  history. `InvitationRecord` removed from the candidate record.
  - Second effect, the one worth having: the veteran gate carried its **own**
    `career_years = 10` beside `[seniority]`'s bounds, so one axis was measured
    against numbers in two tables. `[seniority]` is now the only career
    threshold in the policy.
  - Who was invited is **still recorded**, still travels between machines, still
    reported in `shortlist.csv` and the dossier. `rev-disc invite` is the
    editor's bookkeeping, not an input to the next run's ranking.
- **`geo.bonus`** — computed into every `GeoAssessment` and never read. The
  score uses the component × `scoring.geographic`, which held the same 0.08, so
  tuning `geo.bonus` changed nothing at all.
- **The second identity-confidence threshold** — 0.8 sent a candidate for
  confirmation and a separate hardcoded 0.6 added a note saying the same thing,
  so a candidate at 0.7 was flagged for a human without being told why. Now
  `identity.min_confidence`; the report renderers take the `Policy` rather than
  a list of its filenames.

## Report semantics fixed on the way

- **A REVIEW-level conflict is not a blocking reason.** `render_audit`
  collapsed `REVIEW` into `FILTERED`, so the workbook printed "Conflict of
  interest with the authors" under *Why not recommended* for candidates it
  simultaneously recommended checking — two on a live case. Filtering that
  column for blanks to find who is in play lost them. `filter_coi` carries all
  three states; only an excluding verdict names a reason.
- **A missing public address is `check_first`, not `do_not_invite`.**
  `invitation_readiness` rejected anybody without a verified address, so the
  headline column read "Do not invite" for people no rule had touched — **eight
  of ten invitable candidates** on 2978, one of them clear on all rules with 4
  related journal papers and 139 papers in three years. Structured sources reach
  ~a fifth of this field; the editorial system can address an invitation the
  tool cannot.

## The guard that keeps the workbook honest

The *set* of audit columns is derived (a rule that ran contributes its verdict
and facts; a rule that is `off` contributes nothing). What each column is
**called** cannot be generated, so `tests/test_workbook.py` runs every rule over
records that exercise each branch and refuses: a fact with no heading, a fact
with no glossary entry (unless it is a threshold, whose heading and value *are*
its explanation), and **a label left behind by a deleted rule**. That last check
immediately caught six leftover `unresponsive_veteran` entries.

Result: audit sheet **75 → 45 columns**, decision sheet 16, with no measured
fact lost — the losses were the duplicate career figure, the deleted rules,
`*_known` (the VERIFY verdict says it) and `*_gap` (value beside threshold says
it).

## Not configurable, each on purpose

Documented in `skills/reviewer-discovery/06-report.md`: the ranking order
(conflict → expertise → geography); the seniority ceiling's inability to
exclude; a doctoral candidate with no stated enrolment year (always kept and
marked); any missing fact; and the recency decay on `recent_expertise` (ten
years, linear — it shapes a component rather than gating anybody, and the knob
that matters is that component's weight).
