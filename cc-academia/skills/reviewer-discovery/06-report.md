# 06 — Report

```bash
uv run --project "<plugin-root>" rev-disc report --slug <slug> --top 25 --json
```

Writes into `5-shortlist/`:

- `shortlist.md` — the table to read
- `shortlist.csv` — the same rows, for pasting into the editorial system
- `dossiers/` — one file per candidate, with the full audit trail

## Ranking

The order is fixed and not tunable:

```
conflict status  >  expertise  >  geographic preference
```

Within `CLEAR`, the score is:

```
0.40 topic + 0.20 method + 0.15 recent expertise
+ 0.10 publication evidence + 0.10 geography + 0.05 reviewer history
```

Every component appears in the dossier. A bare "91% suitable" is not something an
editor can act on or defend.

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
