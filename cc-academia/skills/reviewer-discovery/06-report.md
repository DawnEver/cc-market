# 06 — Report

```bash
uv run --project "<plugin-root>" rev-disc report --slug <slug> --top 25 --json
```

The shortlist distinguishes current institution from verified institutional
history. Historical employment and education are reported with dates and
sources, and the header summarises career-country exposure. A person may count
in several historical countries; this is career evidence, not nationality or
ethnicity, and it never overwrites the current-affiliation country.

`shortlist.md` and `shortlist.csv` use one canonical candidate schema and
identical column order. Every cell is a scalar suitable for Excel sorting and
filtering; no cell contains JSON or a delimiter-packed list. One-to-many data is
normalized into detail CSVs, each repeating `rank`, `reviewer`, and `person_id`
so Excel users can sort, filter, join, or place each file on its own worksheet.

Writes into `5-shortlist/`:

- `shortlist.md` — the table to read
- `shortlist.csv` — the same rows, for pasting into the editorial system
- `institutions.csv` — one current or historical institution per row
- `education.csv` — one degree per row
- `evidence.csv` — one qualifying publication per row
- `coi-findings.csv` — one conflict finding per row
- `invitations.csv` — one previous invitation per row
- `reading-list.md` — the qualifying papers, to read before deciding
- `dossiers/` — one file per candidate, with the full audit trail

## Ranking

The order is fixed and not tunable:

```
conflict status  >  expertise  >  geographic preference
```

Within `CLEAR`, the score is:

```
0.35 topic + 0.20 method + 0.15 recent expertise
+ 0.10 publication evidence + 0.08 geography + 0.05 reviewer history
+ 0.07 activity        # the eligibility component
```

Every component appears in the dossier. A bare "91% suitable" is not something an
editor can act on or defend.

## Eligibility

Expertise says a candidate *could* review the manuscript. Eligibility says the
invitation is worth sending. Four rules, all in `configs/coi.toml` and all
overridable per journal:

| Config table | Name in the notes | Default | Fires when |
|--------------|-------------------|---------|-----------|
| `activity` | `recent_activity` | prefer | their publication profile shows no work in the last 3 years |
| `seniority.doctoral` | `doctoral_year` | require | a doctoral candidate before their 3rd year |
| `activity.invitations` | `invitation_response` | prefer | answered under half of the recent invitations whose outcome was recorded |
| `activity.veteran` | `unresponsive_veteran` | require | a 10-year career, at least 2 invitations with a recorded outcome (all-time, not windowed) and none of them answered |

Activity is read from the candidate's own OpenAlex output per year — their
whole record, not the papers this run harvested. The distinction is not
academic: measured against the harvested set, a live TTE run flagged 19 of 22
candidates as dormant, including Z. Q. Zhu, purely because their most recent
work is not on this manuscript's topic. When no profile is available the note
says `[harvested papers only]`, so a weaker basis is visible rather than
implied.

Only an invitation whose outcome was written down counts. Three sent and never
followed up are three unknowns, not three silences, so neither invitation rule
can fire on them. That history lives in the accumulating store and is read back
for every manuscript, not just this workspace's — excluding someone as an
unresponsive veteran here excludes them on the next submission too.

Each carries its own `mode`:

- `off` — not evaluated
- `prefer` — feeds the eligibility component and leaves its reason in the notes
- `require` — the candidate is excluded, and stays on the list with the reason

`require` excludes rather than penalising, for the same reason a conflict does:
blending a policy failure into a score is how somebody who does not meet the
policy climbs back onto the shortlist on expertise alone. Only `prefer` rules
feed the score, and they arrive in one column, `component_activity` — the
fraction of the `prefer` rules the candidate met. It is `1.0` when no rule is in
`prefer` mode, so an all-`require` journal hands the same 0.07 to everyone left
standing rather than ranking them by it.

`activity` overlaps on purpose with `recent_expertise` and `reviewer_history`,
which read the same records from a different angle: those two ask how recent and
how well-received a candidate's *qualifying* work is, this one asks whether they
are still publishing and still answering at all. A journal that considers that a
double count sets `activity = 0.0` in `[scoring]` and keeps the gate.

An excluded candidate keeps `coi_status = CLEAR` — no conflict was detected —
but carries `blocked = True`, an empty score and the reason in `notes`. Blocked
rows sort below every invitable candidate whatever the reason, so the ranking
reads: invitable by conflict status, then expertise, then geography; then
everyone who was removed.

**A missing fact never disqualifies anybody.** No publication years, no stated
enrolment year, no invitation history — each of these is a gap in public data,
not evidence about the person, and each passes. The veteran rule in particular
never fires on career length alone: it needs unanswered invitations recorded in
this workspace, which the first run does not have.

Windows, floors and thresholds are all keys in the config, and a journal file
overlays table by table — state only the keys you change:

```toml
[activity]
recent_years = 5

[seniority.doctoral]
mode = "off"
```

`[seniority]`'s `min_academic_age` and `max_academic_age` sit next to these but
behave differently: they only add a note, and never exclude anybody.

One thing is deliberately not configurable: a doctoral candidate whose enrolment
year is nowhere stated is always kept and marked. Turning that gap into an
exclusion would remove the people with the thinnest public records rather than
the ones who are too junior.

## Geography

Cross-region candidates get a small bonus by default: the submission's origin
country against the candidate's **current affiliation country**. Nothing is
inferred from a name — a Chinese researcher now at Stanford counts as US, which
is both more accurate and avoids profiling reviewers by ethnicity.

An unknown country is neutral, never penalised.

A journal that genuinely requires exclusion rather than preference sets
`geo.mode = "hard_filter"` in its config.

## Presenting it

Walk the user through the top handful rather than dumping the table. For each:

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
