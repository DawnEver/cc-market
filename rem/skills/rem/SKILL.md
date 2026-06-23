---
name: rem
description: REM sleep for Claude sessions — summarize what changed, update memory, compact if needed
---

# REM

## Memory Mechanism (global conventions)


Full conventions — tier promotion rules, frontmatter schema, scoped memory (monorepo),
eviction policy, rules-vs-memory boundary — → `reference/memory-conventions.md`.

### Scripts

Core scripts the happy-path invokes — full table with all scripts and flags → `reference/scripts.md`.

- `prune-memory.js --evict-stale` — always run first
- `rem-prep.js --transcript <path> --promote` — batch touch, auto-promote, compact check
- `stamp-memory.js` — auto-index new memory files
- `compact.js --check` / `scope-split.js --check` — gated procedures (see below)

### Reference

- Full script reference (incl. `check-docs.js`, `task-engine.js`, all flags) → `reference/scripts.md`
- `.claude/.rem-state.json` shape (for debugging hook gating) → `reference/state-schema.md`
- Compact procedure (memory ≥20 entries; user-gated distill) → `reference/compact.md`
- Scope-split procedure (large scope; relocate a cluster into a child scope) → `reference/scope-split.md`

---

## Before anything: prune

**Always run this first:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/prune-memory.js --evict-stale
```
This removes >90d stale entries and keeps the index at ≤20 before you add new entries.

---

Decide depth by checking context:

## Compact (memory index ≥ 20 entries)

Check whether compact is needed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --check
```
Exit 0 = needed, exit 1 = skip. **If needed**, follow the full user-gated distill procedure in
**`reference/compact.md`** (propose → classify → user-confirm → distill into `.claude/rules/rem/`
→ cleanup → check-docs), then continue with the standard REM session below.

## Scope split (large scope + a subdir owns a cluster)

Check whether a memory cluster should move into its own child scope:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --check
```
Exit 0 = a split candidate exists, exit 1 = skip. **If a candidate exists**, follow the
user-gated procedure in **`reference/scope-split.md`** (propose → confirm each split →
execute). Self-disables in flat repos with no internal module boundary. Distinct from compact:
a split relocates entries into a nested scope rather than distilling them into rules.

## Lightweight (doc-only or non-code session)

Brief summary only:
- What was done in one sentence
- Skip `.claude/rules/` and `.claude/memory/` updates unless something surprising came up
- Run `check-docs.js` to detect stale docs — if exit 1, update the flagged files

## Standard

### 0. Run rem-prep (automated mechanical work)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-prep.js --transcript "<transcript_path>" --promote
```

This single command does all of:
- Shows recent prune events (demotions, evictions)
- Scans transcript for `.claude/memory/` file reads → batch-touches `accessed` timestamps and bumps `access_count`
- Auto-promotes short-term entries with `access_count >= 3` to `tier: long`
- Reports compact status (warns if ≥20 entries)

Review the output. Re-promote any entries that were demoted but you referenced this session.

### 1. Summarize

1. What changed and why
2. How it was validated (tests run, manual checks, edge cases)
3. Any open blockers or follow-up items

### 2. Update project memory

- `.claude/memory/YYYY/MM/DD/` — add/update content files under date directory
- Run `stamp-memory.js` to auto-index new files:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/stamp-memory.js
  ```

### 3. Update project docs if needed

- If compact ran: `check-docs.js` already flagged stale docs above — update them now
- If no compact: use judgment — update `AGENTS.md`, `README.md`, etc. if architecture, directory layout, setup steps, or hook behaviour changed this session

### 4. Re-run rem-prep (catch this session's own memory work)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/rem-prep.js --transcript "<transcript_path>" --promote
```

Steps 1-3 above read/edit `.claude/memory/` files (e.g. consolidating entries during compact).
Re-running rem-prep here bumps `accessed`/`access_count` for those files too — step 0 only
saw memory files touched *before* `/rem` started, not the ones touched *during* it.

## Cross-project check

If you modified files in OTHER git repos during this session, you MUST also update their `.claude/memory/` and `.claude/rules/MEMORY.md`. Check your transcript — you know which repos you touched.
