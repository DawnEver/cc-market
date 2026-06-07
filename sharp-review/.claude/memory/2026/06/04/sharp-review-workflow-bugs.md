---
name: sharp-review-workflow-bugs
description: sharp-review.js workflow fixes — Date.now() banned (pass args.date), schema must be object not array (BOTH FIXED)
metadata:
  type: project
created: 2026-06-04
accessed: 2026-06-04
tier: short
---

## Bug 1 — Date.now() / new Date() banned in workflows (FIXED)

Workflow scripts cannot call `Date.now()` or `new Date()` — breaks resume caching. Fixed by passing `args.date` (ISO string) from the skill caller, using it in place of all date derivations.

**Fix:** Pass `date: "YYYY-MM-DD"` in `args` from the skill. `SKILL.md` Step 2 now documents `{ diff, date }`.

## Bug 2 — StructuredOutput schema must be an object (FIXED)

`agent({ schema })` requires a top-level `{ type: 'object' }` schema. Passing `{ type: 'array' }` directly caused all reviewers to fail silently.

**Fix:** Wrapped findings array in `FINDINGS_SCHEMA = { type: 'object', properties: { findings: [...] }, required: ['findings'] }`. Prompt now explicitly instructs: call `StructuredOutput` with `{ "findings": [...] }`.

**Result:** 3/3 reviewers succeed. Dropped Codex/takeover agent types — plain Claude agents are more reliable for schema enforcement.
