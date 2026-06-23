---
name: sharp-review-2026-06-24
description: Sharp review findings — 25 total
metadata:
  type: project
---

## Review 2026-06-24 (session) — architecture hygiene (整洁锐评)

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings

---

### [SR-20260624-001] [INFO] cc-market/ — Takeover MCP tool non-functional (echoed prompt back instead of running Codex); review performed directly by exploring the repo

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Investigate mcp__plugin_takeover_takeover__call_model — it returned the input prompt verbatim instead of model output

codex_status reports installed+authenticated (codex-cli 0.141.0), but call_model with provider=codex mode=agent returned the userPrompt unchanged on two attempts. All findings below come from direct repo exploration.

---

### [SR-20260624-002] [HIGH] cc-market/watch/skills/watch/SKILL.md — Runtime SKILL.md is 170 lines — the largest always-loaded doc; full decision tree inlined

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract the per-status Decision Tree branches (Steps 2-4b, deploy_worktree_dirty/degraded/complete handling) into reference/decision-tree.md, leaving SKILL.md with the monitor-run + branch dispatch only

Steps 2 (branch-on-status, ~50 lines), 4b (plugin self-update), and 6 (in-session Monitor bridge) are mechanism/edge-case detail loaded every invocation. Lines 39-116 could move to reference and load on the relevant branch.

---

### [SR-20260624-003] [HIGH] cc-market/traceme/AGENTS.md — Dev doc is 185 lines and restates runtime billable-token math, schema, and full sync data-model

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move billable-basis math, session_categories unit-split, and the multi-device snapshot data model into skills/traceme/reference/; keep AGENTS.md to architecture diagram + file map + invariants

The 'Billable basis' and 'session_categories' paragraphs and the entire 'Multi-Device Encrypted Sync' section (commands, snapshot payload fields, merge.mjs reader internals) are reference material. AGENTS.md is dev-only and not injected at runtime, so this knowledge is invisible where it's actually needed and drifts against SKILL.md/reference/sync.md.

---

### [SR-20260624-004] [MEDIUM] cc-market/sharp-review/AGENTS.md — 160-line dev doc restates Wave-Gate, host-adaptive fan-out, and generalized-mode procedure already in SKILL.md/reference

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Trim AGENTS.md to the architecture diagram + design seams + dev-only invariants; replace the Wave Gate, host-adaptive fan-out, and generalized-mode prose with one-line links to SKILL.md/reference

The 'Host-adaptive fan-out' block duplicates SKILL.md Step 3a/3b nearly verbatim; the 'Generalized Content Review' ai-post example is restated in three places (SKILL.md §Generalized Mode, AGENTS.md, reference/generalized-mode.md). Per the repo's own dev-vs-runtime invariant, only one copy should hold each fact.

---

### [SR-20260624-005] [MEDIUM] cc-market/sharp-review/skills/sharp-review/SKILL.md — 168-line runtime SKILL.md carries the Codex raw-fan-out raw.json schema and seed-mod reviewer-rotation mechanism inline

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move Step 3b (Codex direct fan-out: seed-mod pairing, raw.json schema, post-review --raw call) into reference/host-fanout.md; keep SKILL.md to the host branch decision + links

Step 3b (lines 82-107) is host-specific mechanism + a JSON schema — exactly the kind of edge-case detail progressive disclosure says belongs in reference/. The Windows-redirection warning (Step 4) and the seed-mod-3 roster math are also reference-grade.

---

### [SR-20260624-006] [MEDIUM] cc-market/rem/.claude/rules/rem/hook-task-guard.md — Dev-only rules file restates the runtime taskActiveUntil procedure that evolve/sharp-review need at runtime

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Reduce hook-task-guard.md to the dev-only 'why' (the pending-work gate exists) and link the runtime 'set taskActiveUntil at round start' instruction to evolve/sharp-review SKILL.md where it actually executes

This rules file (always-injected during rem dev, NOT at skill runtime) tells 'any new multi-round skill MUST set taskActiveUntil'. That is a runtime contract consumed by evolve and sharp-review, whose SKILL/reference must state it independently. Two copies (dev rule vs runtime skill) drift silently — the exact failure mode the repo's own invariants.md warns about with inlineDiffLimit.

---

### [SR-20260624-007] [MEDIUM] cc-market/evolve/AGENTS.md — Evolve docs narrate sharp-review's internal Workflow-vs-raw-fanout fork — a lower-layer implementation detail

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** State only evolve's contract ('run sharp-review, read OPEN findings from backlog'); drop the explanation of how sharp-review picks Workflow vs spawn_agent internally

Both AGENTS.md and reference/round-protocol.md (lines 16-20) explain that 'the Workflow-vs-raw-fan-out fork lives entirely inside sharp-review'. evolve sits above sharp-review; describing the lower layer's host-dispatch internals couples the layers and the text rots when sharp-review changes its fan-out. A boundary-only statement suffices.

---

### [SR-20260624-008] [MEDIUM] cc-market/evolve/skills/evolve/reference/round-protocol.md — Reference file is 261 lines — by far the largest doc in the repo

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Split round-protocol.md into per-concern files (fan-out/grouping, gates, TDD+commit) or fold the host-adaptivity table back to a single line, since attention-gate.md/termination.md/state-schema.md already exist as siblings

At 261 lines it is loaded whole whenever /evolve needs the protocol; the host-adaptivity preamble (lines 1-25) duplicates AGENTS.md's host-adaptivity section and could be one cross-link.

---

### [SR-20260624-009] [LOW] cc-market/rem/skills/rem/SKILL.md — 127-line runtime SKILL.md embeds a full script-usage table that mostly duplicates reference/scripts.md

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Keep only the scripts the /rem happy-path actually invokes inline; move the full 6-row script table to reference/scripts.md (which already exists) and link

reference/scripts.md is explicitly cited as 'full script list', yet SKILL.md re-lists stamp/touch/prune/compact/scope-split/rem-prep with flags — the same drift-prone duplication the cc-market invariants.md calls out.

---

### [SR-20260624-010] [LOW] cc-market/sharp-review/AGENTS.md — Wave-Gate 'implementation detail not covered there' in AGENTS.md is runtime behavior the skill may need

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move lastReviewRef/lastReviewDiff delta-comparison and ref-vanished fallback into reference/profiles-and-modes.md (where thresholds already live) and keep AGENTS.md pointing there

AGENTS.md states it intentionally documents Wave-Gate mechanics 'not covered' in the reference. Splitting one mechanism across a dev doc and a reference doc guarantees a reader sees only half depending on context. Consolidate into the reference.

---

### [SR-20260624-011] [LOW] cc-market/traceme/CLAUDE.md — traceme/CLAUDE.md omits the @.claude/rules/invariants.md include that every other plugin has

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Either add a .claude/rules/invariants.md for traceme (its invariants currently live only in AGENTS.md) or document why traceme has no always-injected dev rules

rem/sharp-review/evolve/takeover CLAUDE.md all chain '@AGENTS.md + @.claude/rules/invariants.md'; traceme is the only one with a bare '@AGENTS.md' and no rules/ dir, so its 'Invariants' section (hooks never block, zero-dep, prompt-never-stored) is not surfaced as an always-on constraint. Inconsistent layering.

---

### [SR-20260624-012] [INFO] cc-market/AGENTS.md — Root AGENTS.md inlines the entire per-plugin test-coverage table (~30 rows) that duplicates each plugin's own AGENTS.md test section

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Keep the run-command and the changed-plugin mapping; drop the per-test-file row table (each plugin's AGENTS.md already lists its suites) to a single 'see each plugin's Testing section' line

The Tests table restates counts/coverage already maintained in rem/AGENTS.md, takeover/AGENTS.md, traceme/AGENTS.md, etc. Two maintained copies of test counts drift the moment a suite changes.

---

### [SR-20260624-013] [HIGH] rem/.claude/rules/invariants.md — 83-line invariants.md restates runtime facts (frontmatter schema, path format, index rules, memory state) already in skills/rem/reference/*.md — violates its own stated principle

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Collapse each section to a one-line dev constraint + link to the reference/* file that owns the runtime truth

Six sections each restate 3-10 lines of runtime behavior that memory-conventions.md already owns. cc-market invariants.md explicitly warns 'Two copies of the same fact drift silently.' At 83 lines it's 6x sharp-review's invariants.md (14 lines).

---

### [SR-20260624-014] [HIGH] rem/skills/rem/SKILL.md — Lines 10-16 inline restate three-tier system + frontmatter fields, then line 18 links to reference/memory-conventions.md — 'for safety' duplication that risks silent drift

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Delete lines 10-16; replace with one line linking to reference/memory-conventions.md

cc-market invariants.md says don't duplicate reference content back into SKILL.md 'for safety'. Lines 13-15 list frontmatter fields that memory-conventions.md already defines; a field rename leaves SKILL.md stale.

---

### [SR-20260624-015] [HIGH] sharp-review/skills/sharp-review/SKILL.md — 168-line SKILL.md (largest in repo) includes 50+ lines of Codex-specific Step 3b fan-out that burns prompt budget on every Claude Code run where it can never execute

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move Step 3b (Codex fan-out) into reference/codex-fan-out.md; keep a 2-line dispatch + link, 3a stays inline as common path

Step 3b defines raw.json schema, reviewer-pair selection, spawn_agent per reviewer, positional alignment — all for a host the executing agent cannot be on. Dispatch to a reference file instead of carrying both branches inline.

---

### [SR-20260624-016] [MEDIUM] rem/skills/todo/SKILL.md — Line 91 'Sharp-review owns findings: post-review.js writes sharp-review.md with rem frontmatter' leaks sharp-review's internal write mechanism into a rem file

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Describe what /todo consumes (the findings), not how sharp-review produces them internally

/todo runs in rem context; spelling out post-review.js means a sharp-review write-path change silently drifts this sentence.

---

### [SR-20260624-017] [MEDIUM] evolve/skills/evolve/SKILL.md — Lines 45-47 and 110-113 directly manipulate rem's internal state key hook.taskActiveUntil in .claude/.rem-state.json — leaks rem's internal schema into evolve's runtime instructions

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add setTaskGuard/clearTaskGuard to evolve.mjs; SKILL.md only calls 'node evolve.mjs guard 30' / 'guard --clear'

evolve depends on rem so coupling is real, but the literal JSON path/key in SKILL.md blocks rem from restructuring state. evolve.mjs already wraps state I/O; extend it to make the boundary explicit.

---

### [SR-20260624-018] [MEDIUM] cc-market/AGENTS.md — Test table (lines 40-72) duplicates per-plugin AGENTS.md test documentation — 32 lines of test counts/coverage kept in sync in two places

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Replace table with one line: 'See each plugin's AGENTS.md § Testing'

Each plugin's AGENTS.md already lists its tests and coverage; the root table is a third copy that will drift from both sources.

---

### [SR-20260624-019] [MEDIUM] sharp-review/AGENTS.md — Architecture diagram (lines 8-37) restates the flow SKILL.md's Step 1-6 already owns — dev doc duplicates runtime doc

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Collapse to one-line architecture map + link to skills/sharp-review/SKILL.md for the step-by-step

The diagram spells out pick-profile.js, diff-manifest.js, merge/dedup, post-review.js flags — same content SKILL.md walks through. AGENTS.md should be a dev-context map, not a runtime procedure restatement.

---

### [SR-20260624-020] [MEDIUM] takeover/.claude/rules/invariants.md — 60-line invariants.md restates retry-logic table (HTTP status→behavior) and mode flags that are runtime behaviors, not dev-only constraints

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move retry table and mode flags to skills/takeover-result/reference/; invariants.md keeps dev-only constraints

Retry table and mode-flag mapping are runtime reference belonging in reference/ files loaded by the skill, not dev-context invariants.

---

### [SR-20260624-021] [MEDIUM] rem/.claude/rules/rem/hook-task-guard.md — Separate rules file duplicates the taskActiveUntil mechanism already in skills/rem/reference/state-schema.md — a third copy of the same fact

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Merge into invariants.md as a one-sentence dev constraint linking to state-schema.md

The mechanism is described in hook-task-guard.md, state-schema.md, rem-hook.js source, and evolve's setup — each a drift point.

---

### [SR-20260624-022] [LOW] watch/skills/watch/SKILL.md — 170-line SKILL.md (2nd largest); the happy path is 3 lines buried inside a 47-line Step 2 branch wall

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move anomaly-handling sub-branches into reference/decision-tree.md; SKILL.md keeps Step 1→branch→happy + link

The 90%-case healthy path is surrounded by edge-case branches the agent must parse on every invocation. Pull edge cases into reference.

---

### [SR-20260624-023] [LOW] traceme/skills/traceme/SKILL.md — 141-line SKILL.md; the dashboard description alone is 13 verbose lines in an always-loaded runtime prompt

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Trim dashboard to 3 lines (what it does + key filters); move full filter list to --help/README

The agent just needs the command exists and to pass args through; the detailed UI filter list belongs in a README, not the runtime prompt.

---

### [SR-20260624-024] [INFO] sharp-review/README.md — Lines 56-66 restate the 'How It Works' flow and Wave Gate already owned by AGENTS.md's diagram — third copy of the same sequence

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** README is user-facing pitch + install; link to AGENTS.md for architecture rather than restate it

AGENTS.md owns the diagram, SKILL.md owns the steps; README need not be a third internal-flow source.

---

### [SR-20260624-025] [INFO] rem/AGENTS.md — File-structure tree (lines 35-64) duplicates what the directory listing already conveys; 57 of 91 lines are diagram+tree

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Keep the architecture flow diagram; drop the file-structure tree — the filesystem is the source of truth for layout

Per-file descriptions must be kept in sync with actual files and add nothing an ls wouldn't provide; each file already has its own docs.
