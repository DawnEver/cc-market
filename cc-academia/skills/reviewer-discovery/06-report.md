# 06 — Report

```bash
uv run --project "<plugin-root>" rev-disc report --slug <slug> --top 25 --json
```

The shortlist distinguishes current institution from verified institutional
history. Historical employment and education are reported with dates and
sources, and the header summarises career-country exposure. A person may count
in several historical countries; this is career evidence, not nationality or
ethnicity, and it never overwrites the current-affiliation country.

## The deliverable

`ongoing/<slug>/<slug>.xlsx`, written beside `0-raw.pdf`. It is the only file
that leaves the workspace, which is why it is named after the case rather than
after its contents: mailed on, renamed by an inbox or dropped in a shared
folder, it still says which submission it belongs to.

Three sheets — `decision`, `audit`, `columns` — built from
`contact-list-audit.csv` and documented in `academia/reviewer/workbook.py`. The
`decision` sheet carries **Homepage or paper**: a clickable link to the ORCID
record, else the publication profile, else the paper of theirs closest to this
manuscript. Never a constructed search or a guessed university homepage — a
dead link in the one file the editor receives is worse than an empty cell.

## The working files

Everything below stays in the workspace. It exists so a verdict can be
disputed, and none of it is handed over.

The workflow exports exactly two CSV tables. `shortlist.csv` is comprehensive:
one row per candidate, scalar columns for sorting plus JSON cells for complete
one-to-many history. `contact-list.csv` is deliberately minimal.

Writes into `5-shortlist/`:

- `shortlist.md` — the table to read
- `shortlist.csv` — the comprehensive table. It includes institutions,
  education, every address, publication evidence, COI findings, and invitation
  history in the corresponding `*_json` columns. `email` is the address that
  won on precedence and `email_alternate` is the other one surfaced directly.
  Read both before writing to anyone
  who has changed institution: a corresponding-author footnote outranks a staff
  page, and it necessarily predates the move, so the higher-ranked address is
  the likelier of the two to be dead.
- `contact-list.csv` — name, email, institution and nothing else, for addressing
  the invitations. Blocked candidates are omitted from this one file: they stay
  in every other export so the editor can see they were considered, but a list
  whose only purpose is to send mail must not carry someone the conflict rules
  removed. A missing address reads `not found` rather than dropping the row.
- `reading-list.md` — the qualifying papers, to read before deciding
- `lookup-coverage.json` — missing, resolved, and never-searched public-data
  counts. A non-zero `never_searched` means reachability coverage is not final.
- `dossiers/` — one file per candidate, with the full audit trail

The domain signal is deliberately advisory. A mismatch can indicate an address
from before an institutional move, but it never reorders or discards an address;
the editor's existing choice to prefer published corresponding addresses is
preserved. `unknown` means there was no defensible institutional domain to
compare, not that the address is current.

## Ranking

The order is fixed and not tunable:

```
conflict status  >  expertise  >  geographic preference
```

Within `CLEAR`, the score is:

```
0.40 topic + 0.20 method + 0.15 recent expertise
+ 0.10 publication evidence + 0.08 geography
+ 0.07 activity        # the eligibility component
```

Every component appears in the dossier. A bare "91% suitable" is not something an
editor can act on or defend.

## Eligibility

Expertise says a candidate *could* review the manuscript. Eligibility says the
invitation is worth sending. **Six rules, and that is all of them** — the list
is closed, it lives in `eligibility.RULES`, and nothing outside that module may
add a ninth. Each is in `configs/coi.toml` and overridable per journal:

| Config table | Rule | Default | Fires when |
|--------------|------|---------|-----------|
| `geo.restricted` | `restricted_country` | off | the current affiliation is in a country the journal will not invite from |
| `activity.related_journals` | `related_journals` | off | too little of the relevant record is journal work |
| `activity.relevant` | `relevant_activity` | prefer | nothing on *this* topic in the last 3 years |
| `activity` | `recent_activity` | prefer | their publication profile shows no work at all in the last 3 years |
| `seniority.doctoral` | `doctoral_year` | require | a doctoral candidate before their 3rd year |
| `seniority` | `seniority` | prefer | fewer than 3 years into an independent career (floor), or past the journal's preferred ceiling |

Every rule reads its quantities off one `CandidateRecord`, built once per
candidate. That is the point of it: `career_length` and `unresponsive_veteran`
used to derive career length separately, one from the run's harvest and one from
the person's profile, and on a live case they disagreed for 158 of 197
candidates by as much as 28 years — in adjacent columns of the same
spreadsheet. Worse, the one reading the harvest was the *preference for
early-career reviewers*, so a 32-year veteran collected the early-career bonus
because the search had only found his recent papers.

`seniority` is one axis with a floor and a ceiling, measured in years since the
doctorate where a doctorate year is stated and years since the first publication
otherwise; the basis is reported, because the two are different claims. **The
floor obeys the mode; the ceiling never excludes anybody**, whatever the mode
says. That is not a nicety — this journal's ceiling was once `require`, which
removed every senior researcher in the pool and left a run with nobody to
invite.

**Nothing reads whether an invitation was answered.** Two rules did — a
windowed response rate and an unresponsive-veteran gate — and both are gone
rather than switched off. They asked one question on two windows, so they agreed
by construction; on any store without a long invitation history both abstained;
and the veteran gate carried its *own* ten-year career threshold beside
`[seniority]`'s, so one axis had two numbers on it in two config tables. The
`reviewer_history` score component went with them, its 0.05 folded into `topic`.

Who was invited is still recorded, still travels between machines, and is still
reported beside a candidate in `shortlist.csv` and the dossier. It is simply not
something any rule or score judges. `rev-disc invite` is now bookkeeping for the
editor rather than an input to the next run's ranking.

`[seniority]` therefore holds the only career threshold in the policy — a floor
and a preferred ceiling on one measured figure.

Each rule's audit columns are named after it — `seniority_years`,
`related_journals_count` — so the workbook groups them by the rule that produced
them instead of by a table of prefixes that goes stale. The *set* of columns is
derived from the rules that ran; what each is *called* is a table in
`reviewer/workbook.py`, and tests run every rule over every branch to refuse a
column with no heading, no explanation, or a heading left behind by a deleted
rule.

Activity is read from the candidate's own OpenAlex output per year — their
whole record, not the papers this run harvested. The distinction is not
academic: measured against the harvested set, a live TTE run flagged 19 of 22
candidates as dormant, including Z. Q. Zhu, purely because their most recent
work is not on this manuscript's topic. When no profile is available the note
says `[harvested papers only]`, so a weaker basis is visible rather than
implied.

Each carries its own `mode`:

- `off` — not evaluated
- `prefer` — feeds the eligibility component and leaves its reason in the notes
- `require` — the candidate is excluded, and stays on the list with the reason

`require` excludes rather than penalising, for the same reason a conflict does:
blending a policy failure into a score is how somebody who does not meet the
policy climbs back onto the shortlist on expertise alone. Only `prefer` rules
feed the score, and they arrive in one column, `component_activity` — the
fraction of the *judged* `prefer` rules the candidate met. A rule that abstained
for want of evidence is not in the denominator: an abstention is the absence of
a measurement, not a met preference. It is `1.0` when nothing was judged, so an
all-`require` journal hands the same 0.07 to everyone left standing rather than
ranking them by it.

`activity` overlaps on purpose with `recent_expertise`, which reads the same
records from a different angle: that one asks how recent a candidate's
*qualifying* work is, this one asks whether they are still publishing at all. A
journal that considers that a double count sets `activity = 0.0` in `[scoring]`
and keeps the gate.

An excluded candidate keeps `coi_status = CLEAR` — **no detected conflict** —
but carries `blocked = True`, an empty score and the reason in `notes`. Blocked
rows sort below every invitable candidate whatever the reason, so the ranking
reads: invitable by conflict status, then expertise, then geography; then
everyone who was removed.

**A missing fact never disqualifies anybody.** No publication years, no stated
enrolment year, **no public address** — each of these is
a gap in public data, not evidence about the person, and each passes. A
candidate with no address reads `check_first`, not `do_not_invite`: the
editorial system can address an invitation this tool cannot, and structured
sources reach only about a fifth of candidates in this field.

Windows, floors and thresholds are all keys in the config, and a journal file
overlays table by table — state only the keys you change:

```toml
[activity]
recent_years = 5

[seniority.doctoral]
mode = "off"
```

A rule set to `off` contributes no outcome and therefore no column, so a run
under a different policy produces a differently shaped file rather than a file
with columns of blanks that read like rules which found nothing wrong.

There is no separate `academic_age` rule any more. It was a floor in years
since the doctorate sitting beside a ceiling in years of publishing, and
whenever a doctorate year was known the two measured the same quantity from
different sources. One axis is one rule.

One thing is deliberately not configurable: a doctoral candidate whose enrolment
year is nowhere stated is always kept and marked. Turning that gap into an
exclusion would remove the people with the thinnest public records rather than
the ones who are too junior.

## Everything that is configurable

One file, `configs/coi.toml`, overlaid table by table by
`configs/journals/<slug>.toml` and then by a user directory via
`ACADEMIA_CONFIG_DIR`. Nothing outside this is tunable, and nothing inside it
is stated twice.

| Table | What it sets |
|-------|--------------|
| `windows` | co-authorship years, dense-collaboration count, shared-doctorate overlap |
| `rules.block` / `rules.review` | which conflict relations exclude and which are flagged |
| `thresholds` | the heavy-citation count |
| `geo` | `mode` — prefer cross-region, hard filter, or off |
| `geo.restricted` | the countries a journal will not invite from |
| `identity` | `min_confidence` before an invitation goes out unasked |
| `seniority` | the one seniority axis: `mode`, `min_years`, `max_years` |
| `seniority.doctoral` | the doctoral year-of-study floor |
| `activity` | still-publishing window and minimum |
| `activity.relevant` | same window, asked of this manuscript's topic |
| `activity.related_journals` | the journal-work floor over the relevant record |
| `scoring` | the six component weights, including `geographic` |
| `retrieval` | pool size, fetch budgets, email precedence and confidence |

Every eligibility table carries a `mode` of `off`, `prefer` or `require`, and
`off` removes the rule's columns from the audit rather than filling them with
blanks.

Deliberately **not** configurable, and each for a reason:

- **The ranking order.** Conflict status, then expertise, then geography. A
  journal that could reorder this could rank a conflicted reviewer first.
- **The seniority ceiling's power to exclude.** It can only ever cost score.
- **A doctoral candidate with no stated enrolment year.** Always kept and
  marked; turning that gap into an exclusion would remove the people with the
  thinnest public records rather than the ones who are too junior.
- **A missing fact.** No publication years, no doctorate year, no invitation
  history, no address: each abstains. There is no switch that makes an absence
  into evidence.
- **The recency decay** on `recent_expertise`: ten years, linear. It shapes a
  component rather than gating anybody, and the knob that matters is that
  component's own weight in `scoring`.

## Geography

Cross-region candidates score higher by default: the submission's origin
country against the candidate's **current affiliation country**. How much
higher is `scoring.geographic`, like every other component — there is no second
key for it. Nothing is
inferred from a name — a Chinese researcher now at Stanford counts as US, which
is both more accurate and avoids profiling reviewers by ethnicity.

An unknown country is neutral, never penalised.

A journal that genuinely requires exclusion rather than preference sets
`geo.mode = "hard_filter"` in its config.

## Presenting it

Hand over the workbook, then walk the user through the top handful rather than
dumping the table. For each:

- who they are and where
- the two or three papers that make them a fit
- the conflict status in words, with the rule when it is not `CLEAR`
- whether an address was found, and from where

Then flag what needs their judgement:

- `REVIEW` candidates — what the flag is, and whether it matters in this case
- low identity confidence — confirm before inviting
- an unusually thin shortlist — nearly always a query problem, so offer to go
  back to step 01 rather than quietly lowering the bar

Say plainly that **Clear\*** means *no detected conflict*. If the user reads it as
a guarantee, correct that: a bibliographic database cannot prove the absence of a
personal, financial or competitive relationship.

## Afterwards

Offer to record who was invited. Invitation history feeds the next manuscript's
ranking; without it, someone who never responds keeps resurfacing at the top of
every shortlist.
