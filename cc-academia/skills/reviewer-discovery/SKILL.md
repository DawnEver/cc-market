---
name: reviewer-discovery
description: Find candidate peer reviewers for a journal submission — profile the manuscript, search the literature, harvest authors of the closest work, screen conflicts of interest deterministically, and produce an evidenced shortlist with institutions, backgrounds and public contact addresses.
allowed-tools: "Read,Write,Bash,Glob,Grep,Agent,Skill,WebFetch,WebSearch"
---

# /cc-academia:reviewer-discovery — candidate reviewers, with evidence

You are the orchestrator for an associate editor. Given a submission, produce a
shortlist they can act on: who, where, why them, any conflict, and how to reach
them.

## The one rule this workflow is built around

**Reviewers are discovered as authors of closely related work — never by asking a
model for names.**

```
submission -> queries -> related papers -> authorships -> candidates
```

A model asked to "suggest ten experts" returns plausible names with nothing
behind them. Even searching by name is unreliable: a live probe for a common
name returned a researcher from an unrelated field. Every candidate in the
output arrives attached to the papers that qualify them.

## Division of labour

| Decided by code | Decided by a model | Decided by you |
|-----------------|--------------------|----------------|
| Which papers are relevant | Phrasing a research summary | Who actually gets invited |
| Who authored them, and how identity was resolved | | Whether a REVIEW-flagged conflict is acceptable |
| Whether a conflict exists | | |
| The ranking | | |

A model never decides a conflict of interest. That verdict has to be defensible
with a rule and a citation, not an opinion.

## Pipeline

| Step | File | Command | Output |
|------|------|---------|--------|
| 01 | `01-intake.md` | `rev-disc init` / `profile` | sanitized record + search profile |
| 02 | `02-search.md` | `rev-disc search` | related papers, de-duplicated, stored |
| 03 | `03-candidates.md` | `rev-disc candidates` | authors of the closest work |
| 04 | `04-enrich.md` | `rev-disc enrich` | affiliation, career, public email |
| 05 | `05-coi.md` | `rev-disc coi` | three-tier verdicts with evidence |
| 06 | `06-report.md` | `rev-disc report` | `shortlist.md` + `.csv` + detail CSVs + `reading-list.md` + dossiers |

Read each step's file when you reach it. This file is the map.

Running the CLI: `_shared/running-the-cli.md`. Host differences:
`_shared/host-adapters.md`.

## Confidentiality

The submission is unpublished and confidential.

- Only `rev-disc init` reads the raw PDF. Everything downstream — including
  everything you see — reads `1-manuscript/sanitized.json`: title, abstract,
  keywords, author metadata. No body text.
- **Do not open `0-raw.pdf` yourself.** The CLI enforces this, and on Claude
  Code a hook blocks it, but the reason it matters is IEEE policy on unpublished
  manuscripts, not the mechanism.
- What leaves the machine is derived search keywords, never the abstract text.
- The database stores a hash of the title, never the title.

## Resume

Re-invoking with a slug picks up where the run stopped:

```bash
uv run --project "<plugin-root>" rev-disc status --slug <slug>
```

| Last completed | Next |
|----------------|------|
| (none) | 01 intake |
| `init` | `profile` |
| `profile` | 02 search |
| `search` | 03 candidates |
| `candidates` | 04 enrich |
| `enrich` | 05 coi |
| `coi` | 06 report |
| `report` | offer to widen the search, adjust the journal policy, or record invitations with `rev-disc invite` |

## Journal policy

Every run is bound to a journal config (`configs/journals/<slug>.toml`), which
sets the co-authorship window, the seniority and eligibility floors and whether
geographic separation is a preference or a hard filter. An unknown journal slug
stops the run rather than quietly applying defaults — reviewing a TIE submission
under the wrong window is exactly the mistake worth failing on.

Every constraint an editor might want to move is a key in `configs/coi.toml` and
a per-journal override, never a number in the code: the activity window, the
doctoral-year floor, the invitation-response threshold, the career length that
makes someone a veteran, and how strictly each is applied (`off`, `prefer`,
`require`). `06-report.md` has the table.

Ask the user for the journal at intake if the manuscript does not say.

## What the shortlist means

- **Clear\*** is *no detected conflict*. Never report it as "no conflict": a
  bibliographic database cannot prove the absence of a personal, financial or
  competitive relationship. Say so if the user reads it as a guarantee.
- **Blocked candidates stay on the list.** An editor needs to see that an obvious
  name was considered and why it was set aside.
- **A score is never the whole answer.** Every row carries its evidence, and each
  dossier breaks the score into components.
- **Email `not found` means not found.** No address is ever generated from a
  name-and-domain pattern; a guess either bounces or reaches the wrong person.

## After the shortlist

Once invitations go out, record them — one command per candidate:

```bash
uv run --project "<plugin-root>" rev-disc invite --slug <slug>   --person <person_id> --invited-at 2026-03-01 --responded yes --accepted no   --note "thorough, on time"
```

Leave `--responded` unset while the outcome is still open. An unrecorded answer
stays unrecorded rather than counting as a silence, and neither responsiveness
rule counts it. Run the command again for the same person when the answer
arrives: it amends that invitation rather than adding a second one.

Invitation history feeds the next manuscript's ranking and is the only evidence
the two responsiveness rules have, so on a fresh store they are inert by design:
the veteran rule cannot fire and the response rule reports "too few to judge".
Offer this; do not do it unasked.
