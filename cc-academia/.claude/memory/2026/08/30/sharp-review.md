---
name: sharp-review-2026-08-30
description: Sharp review findings — 29 total
metadata:
  type: project
---


## Review 2026-08-30 (session) — diff review + docs review (文档锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): OK
- Reviewer deepseek (deepseek): skipped
- Reviewer gmi (gmi): skipped
- Reviewer kimi (kimi): skipped

### Confirmed findings

---

### [SR-20260830-001] [HIGH] src/academia/reviewer/eligibility.py — Unknown invitation outcomes are treated as explicit non-responses and can exclude candidates

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Exclude rows with `responded IS NULL` from response-rate evidence, or evaluate only resolved outcomes.

`_response_rate()` counts every considered invitation in the denominator while counting only truthy `responded` values in the numerator. `record_invitation()` stores `responded=None` for an unresolved outcome, so pending/missing evidence becomes a 0% response rate. Under `require` this excludes a candidate and can trigger the veteran exclusion, violating the missing-evidence-always-passes invariant.

---

### [SR-20260830-002] [HIGH] src/academia/store/repository.py — `min_recent_papers` actually counts publication years, not papers

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Return one row per paper for activity counting, or add a separate publication_count_since() query.

`publication_years()` uses `SELECT DISTINCT p.year` and `_activity()` compares the list length with `min_recent_papers`. Three papers in the same year count as one. Tests conceal this because the fixture creates one paper per year.

---

### [SR-20260830-003] [HIGH] src/academia/reviewer/eligibility.py — Policy can exclude a doctoral candidate solely because the enrolment year is missing

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Remove `unknown_year_passes` and unconditionally pass when the doctoral start year is unavailable.

`_doctoral()` reads `unknown_year_passes` and can return a failing, excluding outcome for `year is None`, making the central invariant optional configuration. Tests cover only the default `true`.

---

### [SR-20260830-004] [MEDIUM] src/academia/reviewer/eligibility.py — Require rules and missing-evidence passes earn preference score and dilute genuine prefer failures

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Compute the activity component from `prefer` rules only; treat `require` outcomes purely as gates and unknown outcomes as neutral.

`Assessment.score` averages every enabled outcome, so a passed `require` rule contributes a bonus and a missing-evidence pass gets full credit. A failed preferred rule is diluted by unrelated required rules that pass, contradicting the stated require/prefer separation.

---

### [SR-20260830-005] [MEDIUM] src/academia/reviewer/rank.py — New activity component double-counts publication recency and invitation responsiveness

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Give each signal one owner: fold activity preferences into recent_expertise/reviewer_history, or remove those signals from the activity aggregate.

`activity` includes recent-publication and invitation-response outcomes while the score already contains `recent_expertise` and `reviewer_history` from the same evidence. The extra 0.07 weight rewards/penalises the same facts multiple times.

---

### [SR-20260830-006] [MEDIUM] src/academia/reviewer/policy.py — Invalid eligibility modes are not validated at config load time

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Construct and validate every configured constraint inside load_policy(), raising a contextual UsageError.

`load_policy()` returns raw merged data; mode validation happens only when a lazy accessor builds a `Constraint` during candidate scoring, so a typo survives intake, search and enrichment before failing at report time. The new test instantiates Constraint directly and never proves invalid TOML is rejected.

---

### [SR-20260830-007] [MEDIUM] src/academia/reviewer/eligibility.py — Recent-activity windows accept future-dated publications and invitations

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use closed boundaries (start_year <= year <= now_year) and treat impossible dates as missing evidence.

`_activity()` and `_response_rate()` enforce only the lower year boundary, so a record dated after `now_year` counts as recent evidence — inflating response rates and letting inactive authors pass. Upper-boundary tests are absent.

---

### [SR-20260830-008] [HIGH] skills/reviewer-discovery/SKILL.md — Documented way to record invitations does not exist - `rev-disc status` only reads state, and no CLI command reaches record_invitation

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add the missing `rev-disc invite`/record-invitation command and document it, or state plainly in SKILL.md and 06-report.md that invitation history is not yet recordable and the two invitation-based rules stay inert.

SKILL.md 'After the shortlist' tells the agent to record invitations with `rev-disc status --slug <slug>` - the identical command it gives for resume/status. dispatch.py:186 registers `status` with only a display argument; there is no write path. repository.record_invitation (repository.py:683) is dead code outside tests. Two of the four new eligibility rules (activity.invitations, activity.veteran, the latter shipping as mode=require) key entirely off invitation history, so the veteran exclusion can never fire and the invitation-response rule is permanently 'too few to judge'.

---

### [SR-20260830-009] [MEDIUM] skills/reviewer-discovery/06-report.md — 'Three rules' heading is immediately followed by a four-row table

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Say four, and add the invitation-response rule to the eligibility.py docstring bullet list.

The Eligibility section says 'Three rules, all in configs/coi.toml' then tables activity, seniority.doctoral, activity.invitations, activity.veteran - four. The same stale count is in the module docstring of eligibility.py, which omits invitation_response entirely.

---

### [SR-20260830-010] [MEDIUM] skills/reviewer-discovery/06-report.md — Score formula names the component 'eligibility'; the config key and export column are both 'activity'

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document the real key name: `+ 0.07 activity (the eligibility component)`, and note the score is exported as component_activity.

06-report.md documents `+ 0.07 eligibility`. In code the component key is `activity`, the [scoring] weight key is `activity = 0.07`, and the column is `component_activity`. An editor who follows the doc and adds `eligibility = 0.10` to [scoring] gets a silently ignored key - policy.weights uses weights.get(k, 0.0), so the contribution drops to zero with no error. `activity` in [scoring] is also easily confused with the [activity] rule table.

---

### [SR-20260830-011] [MEDIUM] skills/reviewer-discovery/06-report.md — Ranking description is wrong for eligibility exclusions - require failures sort inside CLEAR, above REVIEW candidates

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document that blocked is now true for both COI blocks and require eligibility failures with coi_status staying CLEAR, or add eligibility to the sort key in rank.py.

06-report.md states the order is conflict status > expertise > geographic preference and says require 'excludes for the same reason a conflict does'. In rank.rank() the primary sort key is coi_status severity only. An eligibility-excluded candidate keeps coi_status == CLEAR with score = -inf, so they sort within the CLEAR block, above every REVIEW-flagged candidate. The CSV shows blocked=True with coi_status=CLEAR and an empty score, a combination no document explains.

---

### [SR-20260830-012] [MEDIUM] skills/reviewer-discovery/06-report.md — Output list omits reading-list.md, which write_all always writes

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add reading-list.md to the list; also update SKILL.md's pipeline table, which still summarises step 06 as shortlist.md + .csv + dossiers.

The 'Writes into 5-shortlist/' list enumerates shortlist.md, shortlist.csv, the five detail CSVs and dossiers/. report.write_all also writes reading-list.md and returns it under the reading_list key.

---

### [SR-20260830-013] [MEDIUM] skills/reviewer-discovery/04-enrich.md — Claims the agent supplies an enrolment year via the homepages payload - no such field exists

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Say the rank alone is agent-supplied and the year of study comes only from ORCID education, or add the field to the homepages schema.

'Academic position' says 'the rank and the enrolment year you supply here decide whether a student is filtered or kept'. The --homepages schema accepts only urls, rank and rank_source. Person.doctoral_year (models.py:331) reads year_from off the ORCID education entry matching /ph.?\s?d|doctor/ - nothing an agent hands back can set it.

---

### [SR-20260830-014] [MEDIUM] CHANGELOG.md — 'Missing evidence always passes' is stated absolutely, but unknown_year_passes can be set to false

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Document unknown_year_passes with an explicit warning, or drop the key and make the invariant real.

CHANGELOG and 06-report.md state the invariant without qualification and eligibility.py's docstring repeats it. But _doctoral reads constraint.get('unknown_year_passes', True) and configs/coi.toml exposes it as a per-journal key. Setting it false with mode=require excludes every doctoral candidate whose ORCID lacks an enrolment year. Either the key or the invariant is wrong, and no document mentions the key exists.

---

### [SR-20260830-015] [MEDIUM] README.md — README still claims a conflict is the only thing that removes a candidate; eligibility now removes them too

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a short eligibility paragraph to README and correct the students sentence to reflect the shipped doctoral floor.

README says 'A conflict removes a candidate rather than deducting points' and describes students as staying 'on the list, flagged, rather than being dropped'. Both are now inaccurate: rank.score_candidate sets BLOCKED_SCORE on any require eligibility failure, and the shipped default [seniority.doctoral] mode=require, min_year=3 drops first- and second-year doctoral candidates outright. The eligibility gate is absent from README entirely.

---

### [SR-20260830-016] [LOW] skills/reviewer-discovery/06-report.md — Veteran rule's 'fires when' omits the minimum-invitation precondition

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State 'a 10-year career and at least 2 invitations on record, none answered (all-time, not windowed)'.

The table says the veteran rule fires on a 10-year career and no answer to any invitation. _veteran additionally requires invited >= min_invitations (default 2) and measures the response rate over the whole history, not the recent_years window used by the other rules.

---

### [SR-20260830-017] [LOW] skills/reviewer-discovery/06-report.md — Canonical export schema is asserted but never listed, so component_activity is documented nowhere

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a column reference documenting the seven component_* columns and that component_activity is the eligibility pass fraction.

The section claims shortlist.md and shortlist.csv use one canonical schema but no document lists the 46 columns in report.py EXPORT_COLUMNS. The new component_activity column - the visible surface of the whole feature - appears in no playbook, so an editor has no idea 1.0 is the value every candidate gets when all rules are off.

---

### [SR-20260830-018] [LOW] skills/reviewer-discovery/04-enrich.md — Example command uses --limit 40, which the CLI's own help warns against

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Use the default in the example and mention the cap only as an explicit cost-control option with the warning.

The headline command is `rev-disc enrich --slug <slug> --limit 40 --json`. The CLI default is 0 = all and its help says a cap 'can leave top candidates unscreened'. With eligibility now also reading enrichment-derived rank and education, a cap silently changes who is excluded.

---

### [SR-20260830-019] [LOW] AGENTS.md — Principles file explains BLOCK-vs-penalty for conflicts only; the identical decision for eligibility is unrecorded

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a short 'Eligibility is policy, not expertise' section.

AGENTS.md documents the BLOCK principle and 'unknown is neutral everywhere else' but never mentions eligibility, so the 'why' file no longer covers a subsystem that removes people from shortlists.

---

### [SR-20260830-020] [INFO] configs/journals/tte.toml — No shipped journal config exercises the new eligibility keys the docs advertise as per-journal

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a commented eligibility overlay to one journal file, or a two-line example in 06-report.md.

SKILL.md says a journal config sets the eligibility floors and 06-report.md says 'A journal that wants a 5-year activity window and no doctoral floor says exactly that'. All three shipped journal files override only [windows] coauthor_years. The _merge semantics for a partial [activity] table are also undocumented.


## Review 2026-08-30 (follow-up)

## Review 2026-08-30 (session) — docs review (文档锐评)

### Reviewer Status
- Reviewer claude (claude): OK
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): skipped
- Reviewer gmi (gmi): skipped
- Reviewer kimi (kimi): skipped

### Confirmed findings

---

### [SR-20260830-021] [MEDIUM] skills/reviewer-discovery/06-report.md — Docs describe invitation thresholds as counting invitations "on record", but code counts only invitations with a resolved outcome (responded IS NOT NULL).

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Reword the veteran row to "at least 2 invitations with a recorded outcome" and the invitations row similarly; mirror in configs/coi.toml next to min_invitations.

eligibility._response_rate filters rows where responded is not None before counting, and both _invitation_response and _veteran compare min_invitations against that filtered count. Three invitations recorded without --responded yield zero countable invitations, so neither rule can fire - the opposite of what the docs and min_invitations = 2 imply.

---

### [SR-20260830-022] [MEDIUM] configs/coi.toml — Invitation history is described as this workspace's own history, but it is read from the shared global SQLite store across all manuscripts and workspaces.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Say "read from the local accumulating store, across every manuscript it holds" in coi.toml, 06-report.md and the run_invite docstring.

repository.invitation_history selects from review_history by person_id only, with no slug/ms_id scoping, over the shared db.session() store. The claim recurs in coi.toml [activity.invitations], 06-report.md and rev_disc.run_invite. A person excluded by the veteran rule in one workspace is excluded in every other.

---

### [SR-20260830-023] [MEDIUM] configs/coi.toml — thresholds.minimum_evidence is documented as a tunable but is read nowhere in the codebase.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Delete the key and its comment, or implement it in the COI rule engine.

Repo-wide grep for minimum_evidence returns only the coi.toml line. Policy exposes only heavy_citation_threshold from [thresholds]. Editors setting it believe they raised the evidence bar; nothing changes - contradicting SKILL.md's "every constraint is a config key" claim.

---

### [SR-20260830-024] [LOW] CHANGELOG.md — Unreleased entry omits the new activity = 0.07 scoring weight, a silent ranking change for every existing shortlist.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a Changed bullet noting [scoring] gains activity = 0.07 and that pre-release scores are not comparable.

coi.toml [scoring] now carries activity = 0.07, consumed in rank.score_candidate via components activity. The Added block covers the rules and rev-disc invite but not the weight.

---

### [SR-20260830-025] [LOW] src/academia/cli/rev_disc.py — rev-disc invite requires an existing profile.json in the workspace; documented usage does not say so.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Note in SKILL.md that invite must run against a workspace that reached profile, or fall back to state.ms_id instead of loading the profile.

run_invite calls _load_profile(workspace) for profile.manuscript_id before writing. SKILL.md and 06-report.md present invite as standalone bookkeeping taking only --slug --person --responded --accepted; without profile.json it fails.

---

### [SR-20260830-026] [LOW] skills/reviewer-discovery/SKILL.md — Documented rev-disc invite invocation omits --invited-at and --note and does not mention that re-invoking upserts the same row.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Show the full flag set once and state that a second call for the same person+manuscript amends the outcome rather than appending.

dispatch.py defines --slug, --person, --invited-at, --responded, --accepted, --note. repository.record_invitation uses ON CONFLICT(person_id, ms_id) DO UPDATE with coalesce, so incremental recording is the intended workflow.

---

### [SR-20260830-027] [LOW] skills/reviewer-discovery/06-report.md — component_activity is documented as 1.0 when no rule is switched on, but it is also 1.0 when every enabled rule is in require mode.

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Rewrite as: the fraction of prefer rules the candidate met; 1.0 when no rule is in prefer mode.

eligibility.assess computes passed / len(preferred) over non-excluding outcomes and returns 1.0 when preferred is empty, so an all-require journal grants a uniform 0.07 bonus to everyone still invitable.

---

### [SR-20260830-028] [INFO] skills/reviewer-discovery/06-report.md — Rule identifiers that appear in notes and dossiers (recent_activity, doctoral_year, invitation_response, unresponsive_veteran) are undocumented.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Add a column to the eligibility table mapping each config table path to the rule name printed in notes.

policy.py names the constraints and RuleOutcome.rule carries those strings into the report, while the docs use only TOML paths (activity, seniority.doctoral, ...).

---

### [SR-20260830-029] [INFO] configs/journals/tte.toml — [seniority] min_academic_age / max_academic_age are live keys that only produce a note and never exclude; no doc says so.

- **Category:** Feature
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** State in 06-report.md that academic-age bounds annotate only, unlike the require-capable eligibility rules.

rank._seniority_note appends a note and nothing else; there is no exclusion path. Sitting directly above [seniority.doctoral], which does exclude under require, the asymmetry is easy to misread.
