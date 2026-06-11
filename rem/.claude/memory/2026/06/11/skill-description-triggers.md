---
name: skill-description-triggers
description: Skill description wording drives false triggering — broad task verbs ("resolve tasks") fired /todo on plain "go do X" requests; add explicit negative triggers
metadata:
  type: feedback
created: 2026-06-11
accessed: 2026-06-11
tier: short
---

The `/todo` skill (rem) was wrongly triggered by the user saying "去做" / "go do X" —
a direct request to act, not a task-list operation. Root cause: the skill `description`
read "Manage the project task list — view, add, check, and resolve tasks." The phrase
"resolve tasks" / generic task verbs made the model classify any "do this task" intent as
a `/todo` invocation.

**Why:** A skill's `description` is the sole trigger signal at runtime (the dev-time
AGENTS.md/CLAUDE.md are not injected — see [[dev-vs-runtime-context-invariant]]). Broad,
action-flavored verbs over-match. The fix is to (1) scope the description to *explicit
operations on the stored list* and (2) add an explicit negative trigger naming the
confusable phrasing.

**How to apply:** When a skill mis-fires, tighten its `description`: name the concrete
artifact it operates on, and add a "do NOT trigger when…" clause quoting the phrasing that
caused the false positive. Keep it short. Final /todo wording: "List, add, mark, or remove
entries in the persisted `/todo` task backlog. Only for explicit operations on that stored
list — not for 'go do X' requests to act ('去做', '做一下')."
