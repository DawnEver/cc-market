---
name: rem
description: REM sleep for Claude sessions — summarize what changed, update memory, compact if needed
---

# REM

## Memory Mechanism (global conventions)

These conventions apply to ALL projects. Only loaded via `/rem` — not burned every session.

Three tiers: `.claude/rules/*.md` (always injected, never evicted), long-term memory
(`tier: long`, immune to 90d eviction), and short-term memory (`tier: short`, 90d eviction
window). Each memory file has YAML frontmatter (`name`, `description`, `metadata.type`,
`created`, `accessed`, `tier`, `access_count`) and is indexed in `.claude/rules/MEMORY.md`
(max 20 entries, sorted by `accessed`).

Full conventions — tier promotion rules, frontmatter schema, scoped memory (monorepo),
eviction policy, rules-vs-memory boundary — → `reference/memory-conventions.md`.

### Scripts (plugin, at `${CLAUDE_PLUGIN_ROOT}/scripts/`)
| Script | Usage |
|---|---|
| `stamp-memory.js` | Initialize: create dirs + MEMORY.md, add `created`/`accessed`/`tier` to all files, scan & index |
| `touch-memory.js <path>` | Bump `accessed` to today. `--promote` to upgrade `tier: short` → `long`. |
| `prune-memory.js` | Enforce 20-entry cap + 90d eviction (short-term only, long-term protected). `--evict-stale`. |
| `compact.js` | Orchestrate compact mode. `--check`, `--execute --distilled <paths>`, `--validate`. |
| `rem-prep.js` | Pre-REM automation: event log, batch touch, auto-promote, compact check. `--transcript <path> --promote`. |

### Reference

- Full script list (incl. `check-docs.js`, `task-engine.js`) → `reference/scripts.md`
- `.claude/.rem-state.json` shape (for debugging hook gating) → `reference/state-schema.md`

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

First, check if compact is needed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --check
```
Exit 0 = needed, exit 1 = skip.

**If compact needed, present the proposal to the user before acting:**

1. Run the propose command to get structured data:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --propose
```
This outputs JSON with every indexed entry, including its tier, access_count, and description.

2. Classify each entry as rule-worthy or keep-as-memory:
   - **Rule-worthy** (should be always-injected): durable insights, behavioral constraints, invariants, gotchas that apply every session. Typically entries with `tier: long` and `access_count >= 5`.
   - **Keep-as-memory** (on-demand): historical reference, one-off decisions, bug-specific notes, context useful but not needed every session.

3. Present the classification to the user with AskUserQuestion (multiSelect) — let them deselect items they want kept as long-term memory.

4. After user confirmation, read ONLY the approved-to-be-rules entries and distill them into `.claude/rules/rem/` rule files, organized by topic:
   - `.claude/rules/rem/hook.md` — hook behavior and guards
   - `.claude/rules/rem/api-proxy.md` — proxy gotchas and invariants
   - `.claude/rules/rem/takeover.md` — plugin architecture
   - etc. Group related memory topics under the same rule file.
   - **Do NOT distill entries the user chose to keep as long-term memory.**
   - Update any outdated rules already in `.claude/rules/rem/`.

5. Run the cleanup script with ONLY the distilled paths:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --execute --distilled 2026/05/27/feedback_git_commit.md,2026/05/28/retrospect_hook_task_guard.md
```
This removes only the distilled entries from the index — un-distilled entries stay. Without `--distilled`, clears all entries (full reset).

6. Check documentation freshness:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check-docs.js
```
If exit 1, uncommitted changes were found and doc files are stale — update the flagged docs before proceeding.

**Manual verification:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --validate
```

**Namespace rule (enforced by compact.js):**
- Hand-written rules (one-off, project-specific) → `.claude/rules/<topic>.md`
- Compact-distilled rules (from memory consolidation) → `.claude/rules/rem/<topic>.md`
- `.claude/memory/` is append-only — compact.js verifies no files were deleted

Then continue with the standard REM session below.

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
