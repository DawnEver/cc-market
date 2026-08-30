---
name: reviewer-eligibility-gate
description: "Configurable eligibility gate for reviewer-discovery, rev-disc invite, and why activity must be read from the publication profile rather than the local store"
metadata:
  type: project
---

# cc-academia: the reviewer eligibility gate

Commits `c28ef44` (feature) and `52b3bfa` (fix from the live run), both on
`main`, **unpushed**. Asked for: prefer authors active and responsive in the
last three years, hold doctoral candidates to third year or later, drop the
long-career expert who no longer accepts review work — and make every one of
those constraints configurable.

## The shape: a gate beside the score, not another score component

Expertise says a candidate *could* review; eligibility says the invitation is
worth sending. Four rules in `configs/coi.toml`, each with its own mode:

| Config table | Rule name in notes | Default |
|---|---|---|
| `activity` | `recent_activity` | prefer |
| `seniority.doctoral` | `doctoral_year` | require |
| `activity.invitations` | `invitation_response` | prefer |
| `activity.veteran` | `unresponsive_veteran` | require |

`off` skips, `prefer` annotates and feeds one score component, `require` sets
`BLOCKED_SCORE` exactly the way a COI `BLOCK` does. The reason `require` excludes
rather than penalising is the same reason a conflict does: blending a policy
failure into a score is how somebody who fails the policy climbs back onto the
shortlist on expertise alone.

Only `prefer` rules feed `component_activity` — a `require` rule has already had
its say, and letting it also pay a bonus dilutes a genuine preference failure
with gates everybody passes.

## The bug the live run caught — measure the right population

The activity rule first counted papers in the local store. The store only holds
what *this run's queries harvested*, so the rule was really asking "is this
person's most recent work on this manuscript's topic" — not "do they still
publish". On the live TTE run it flagged **19 of 22 invitable candidates as
dormant, Z. Q. Zhu among them**.

Fix: store OpenAlex `counts_by_year` per person (`person_output` table, filled
during enrich, one extra select field and no extra request) and read both recent
activity and career length from that. The store years remain only as a fallback,
and the note then says `[harvested papers only]` so the weaker basis is visible
rather than implied.

**Generalise this:** the accumulating store is a topic-filtered sample of the
literature, never a person's record. Any question about a *person* — output,
career span, breadth — must come from their bibliographic profile. Same failure
family as the parsed-then-dropped bugs in `2026/08/29`: the data was there, the
wrong population was asked.

## Missing evidence always passes, and partly not configurable

No publication years, no enrolment year, an invitation whose outcome nobody
recorded — each is a gap in public data, not a fact about the person. Two
specifics worth keeping:

- `responded` is nullable. Counting a pending invitation as a silence lets a
  field the editor simply has not filled in exclude a reviewer. Only resolved
  outcomes count, and `min_invitations` counts *those*.
- An unstated doctoral enrolment year always passes, and there is deliberately
  no config key for it. ORCID states one for a minority, so a switch would
  remove the people with the thinnest records rather than the ones too junior.
  A first review round proposed such a key; it was removed rather than
  documented.

## `rev-disc invite` — the documented command that did not exist

SKILL.md told the agent to record invitations with `rev-disc status`, which is
read-only. `repo.record_invitation` was dead code outside tests, so two of the
four rules keyed entirely off invitation history and neither could ever fire.
Added `rev-disc invite --person <id> [--invited-at --responded --accepted
--note]`; it takes `ms_id` from workspace state rather than requiring
`profile.json`, so an outcome can be recorded months later.

Invitation history is **store-wide, not per-workspace** — `review_history` is
keyed by person only. Excluding someone as an unresponsive veteran on one
manuscript excludes them on every later one.

## Live run: TTE-Reg-2026-08-2905 (this machine, fresh store)

277 papers → 23 candidates at `--min-evidence 2` → 22 CLEAR + 1 BLOCK
(Zhongze Wu, a submitting author — rule engine correct). Enrichment: 6 emails,
12 education records, 10 positions. After the activity fix every candidate
passes the activity rule, which is plausible for this field.

Both invitation rules were inert (no history on a fresh store) and the doctoral
floor fired on nobody — ORCID almost never states a doctoral job title, so the
rank still comes from the agent-owned homepage step in `04-enrich.md`. Both are
by design, but it means the shipped defaults do very little until an editor has
run the contacts loop and recorded some invitations.

## Review rounds

Two sharp-review passes, 29 findings, 28 addressed (see
`2026/08/30/sharp-review.md`). Declined on purpose: `activity` overlapping with
`recent_expertise` / `reviewer_history` — they read the same records from a
different angle, and the overlap is documented with `activity = 0.0` given as
the way out. Scoring weights changed (`topic` 0.40→0.35, `geographic`
0.10→0.08, new `activity` 0.07), so scores are not comparable with earlier
shortlists.
