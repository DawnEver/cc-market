---
name: rem
description: REM sleep for Claude sessions — summarize what changed, update memory, crystallize if needed
---

# REM

## Execution mode (read first)

rem summarizes **this session**, so it needs live context — offload via **`fork`**
(`subagent_type: "fork"`), not a fresh subagent: the fork inherits the conversation (first-hand
summary) yet keeps prune/prep/stamp/memory-write noise out of the main session.

1. **Main loop first** runs the user-gated checks (a background fork can't prompt):
   `crystallize.js --check` and `scope-split.js --check` — if either fires, do its interactive
   procedure (`reference/crystallize.md` / `scope-split.md`) inline before forking.
2. **Then dispatch one `fork`** for the standard pass (prune → rem-prep → summarize → write
   memory → stamp → re-run rem-prep), returning a one-line recap. The fork must not re-fork or
   touch crystallize/scope-split.

Lightweight (doc-only) sessions are cheap — running inline is fine.

## Memory Mechanism (global conventions)


Full conventions — tier promotion rules, frontmatter schema, scoped memory (monorepo),
eviction policy, rules-vs-memory boundary — → `reference/memory-conventions.md`.

### Scripts

Core scripts the happy-path invokes — full table with all scripts and flags → `reference/scripts.md`.

- `prune-memory.js --evict-stale` — always run first
- `rem-prep.js --transcript <path> --promote` — batch touch, auto-promote, crystallize check
- `stamp-memory.js` — auto-index new memory files
- `crystallize.js --check` / `scope-split.js --check` — gated procedures (see below)

### Reference

- Full script reference (incl. `check-docs.js`, `task-engine.js`, all flags) → `reference/scripts.md`
- `.claude/.rem-state.json` shape (for debugging hook gating) → `reference/state-schema.md`
- Crystallize procedure (memory ≥20 entries; user-gated distill) → `reference/crystallize.md`
- Scope-split procedure (large scope; relocate a cluster into a child scope) → `reference/scope-split.md`
- Standard-pass walkthrough + Lightweight variant → `reference/standard-procedure.md`

---

## Before anything: prune

**Always run this first:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/prune-memory.js --evict-stale
```
This removes >90d stale entries and keeps the index at ≤20 before you add new entries.

---

Decide depth by checking context:

## Crystallize (memory index ≥ 20 entries)

Check whether crystallize is needed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.js --check
```
Exit 0 = needed, exit 1 = skip. **If needed**, follow the full user-gated distill procedure in
**`reference/crystallize.md`** (propose → classify → user-confirm → distill into `.claude/rules/rem/`
→ cleanup → check-docs), then continue with the standard REM session below.

## Scope split (large scope + a subdir owns a cluster)

Check whether a memory cluster should move into its own child scope:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --check
```
Exit 0 = a split candidate exists, exit 1 = skip. **If a candidate exists**, follow the
user-gated procedure in **`reference/scope-split.md`** (propose → confirm each split →
execute). Self-disables in flat repos with no internal module boundary. Distinct from crystallize:
a split relocates entries into a nested scope rather than distilling them into rules.

## Lightweight (doc-only or non-code session)

Brief one-sentence summary; usually no memory/rules updates. Run the doc-staleness checks
(`check-docs.js`, `doc-freshness.js`) — full checklist → **`reference/standard-procedure.md`** § Lightweight.

## Standard

Short flow (run in the fork): **0.** `rem-prep.js --transcript "<transcript_path>" --promote`
→ **1.** summarize (what changed, validation, blockers) → **2.** write `.claude/memory/YYYY/MM/DD/`
entries + `stamp-memory.js` → **3.** update project docs if needed → **4.** re-run rem-prep to
catch this session's own memory work.

Full step-by-step walkthrough (what rem-prep does, doc-update judgment, why step 4 exists) →
**`reference/standard-procedure.md`**.

## Cross-project check

If you modified files in OTHER git repos during this session, you MUST also update their `.claude/memory/` and `.claude/rules/MEMORY.md`. Check your transcript — you know which repos you touched.
