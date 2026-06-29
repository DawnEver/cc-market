---
name: sharp-review-2026-06-29
description: Sharp review findings — 9 total
metadata:
  type: project
---

## Review 2026-06-29 (session) — docs review (文档锐评) + diff review

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): skipped
- Reviewer C (Opus): OK

### Confirmed findings

---

### [SR-20260629-001] [HIGH] sharp-review/agents/sharp-review.md — Worker prompt still documents a single profile even though pick-profile.js returns an array of profiles

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update Step 1 to capture a JSON array, Step 3 to apply the empty-diff gate only when all selected profiles honor the diff manifest, and raw.json to include profiles/profileLabel aligned with active reviewers.

pick-profile.js outputs an array of resolved profiles and direct-fanout.md assigns reviewer[i]→profiles[i], but agents/sharp-review.md says 'Pick profile' (singular), captures `{ key, label, mode, ... }`, uses `profile.mode`, and stores only profileLabel. A worker following this prompt mishandles multi-profile rounds.

---

### [SR-20260629-002] [MEDIUM] sharp-review/skills/sharp-review/SKILL.md — SKILL.md says takeover is the primary fan-out path but never states the worker agent must allowlist the takeover MCP tool

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a prerequisite in Step 3 / Execution mode: the worker's tools: list must include mcp__plugin_takeover_takeover__call_model or fan-out silently falls back.

This is exactly the bug that caused 0/2 reviewers to fail. The agent now lists the tool, but SKILL.md (runtime source of truth) does not document the requirement.

---

### [SR-20260629-003] [MEDIUM] sharp-review/skills/sharp-review/SKILL.md — SKILL.md still implies every reviewer returns raw JSON and omits the codex prose-to-schema parsing requirement

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** In Step 3 document that codex provider + mode=review returns prose and the worker must parse it into { findings: [...] } before writing raw.json.

Step 3 says collect each reviewer's raw { findings } and feed to post-review.js, contradicting the codex review-mode behavior now documented in agents/sharp-review.md and direct-fanout.md.

---

### [SR-20260629-004] [LOW] sharp-review/skills/sharp-review/reference/direct-fanout.md — direct-fanout.md contradicts itself: early rule says no valid JSON → failure, later carves out codex prose parsing

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change the early failure rule to scope JSON requirement to non-codex reviewers; codex prose is parsed and only null when no findings can be extracted.

Top section says a takeover call with no valid JSON → null; the added note says codex prose should not be marked failed. Readers can follow the earlier rule and null out valid codex reviews.

---

### [SR-20260629-005] [LOW] sharp-review/AGENTS.md — AGENTS.md still describes reviewers as JSON-Schema-constrained without noting codex review-mode returns prose

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Qualify the architecture summary: deepseek/claude return schema JSON directly; codex review-mode returns prose the worker normalizes before merge.

AGENTS.md says three reviewers have JSON Schema constraints and fan-out collects raw { findings }, stale for the codex takeover review path.

---

### [SR-20260629-006] [LOW] sharp-review/.claude/rules/invariants.md — Invariant 'each reviewer returns { findings: [...] }' is now only true after host-side normalization for codex

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Clarify the invariant applies to rawResults handed to post-review.js, not the provider's native response; codex prose must be normalized first.

Accurate for post-review.js input but misleading as a fan-out rule after the codex change — implies codex prose is invalid rather than requiring worker-side parsing.

---

### [SR-20260629-007] [MEDIUM] sharp-review/agents/sharp-review.md — Ambiguous codex 'clean' vs 'failed' can collapse a reviewer failure into a silent pass

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Require an explicit affirmative 'no issues' signal from codex prose to map to []; otherwise treat non-finding, non-affirmative prose as null. Log which branch was taken.

The rule says codex prose with no issues → [], and null only when 'errored or returned empty/unparseable output with no findings'. A degraded/truncated/off-topic prose response with no parseable findings is indistinguishable from a genuine clean review, and the model will tend to map it to [], swallowing a reviewer failure with zero observability since merge treats null=failed, []=passed-clean.

---

### [SR-20260629-008] [MEDIUM] sharp-review/skills/sharp-review/reference/direct-fanout.md — codex-prose contract duplicated in two files with already-divergent wording

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Define the codex-prose parsing rule once (canonical location) and link to it from both the agent and the direct-fanout reference.

agents/sharp-review.md spells out the precise null definition; direct-fanout.md omits null semantics entirely. Because these are LLM-consumed, the two paths make different null/[] decisions for the same codex output, and will drift further on the next edit.

---

### [SR-20260629-009] [LOW] sharp-review/agents/sharp-review.md — Model-side prose parsing has no schema-validation step, inviting malformed/hallucinated findings

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** State that parsed-from-prose findings must be validated against the schema (drop entries missing required severity/summary/category) before merging; note prose parsing may invent or mis-severity findings.

'YOU parse the prose into the findings schema' with no validation means free-form severity language is mapped to HIGH/MEDIUM/LOW/INFO by guesswork and file fields may be fabricated; no guard ensures required fields are present before merge.
