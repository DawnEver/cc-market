---
name: rem
description: REM sleep for Claude sessions — summarize what changed, update memory, compact if needed
---

# REM

## Memory Mechanism (global conventions)

These conventions apply to ALL projects. Only loaded via `/rem` — not burned every session.

### Three-tier loading
| Tier | When | Content | Eviction |
|---|---|---|---|
| `.claude/rules/*.md` | Always injected | Core behavioral constraints ALL agents must follow. Keep under ~10 lines. | Never (hand-curated) |
| Long-term memory (`tier: long`) | On-demand, progressive disclosure via MEMORY.md | Frequently accessed/updated memories. Promoted from short-term. | Immune to 90d eviction |
| Short-term memory (`tier: short`) | On-demand, progressive disclosure via MEMORY.md | Session notes, one-off fixes, historical reference. | 90d eviction window |

**Promotion:** When a short-term memory is accessed 3+ times across sessions, promote it:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/touch-memory.js <path> --promote
```
This sets `tier: long`, making it immune to eviction.

### Memory file format
```yaml
---
name: kebab-case-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
created: YYYY-MM-DD
accessed: YYYY-MM-DD
tier: short | long
---
```
- `created` — parent folder date
- `accessed` — bumped by `touch-memory.js` whenever referenced in a session
- `tier` — `short` by default; promoted to `long` via `touch-memory.js --promote` when frequently accessed

### Index (`.claude/rules/MEMORY.md`)
- Sorted by `accessed` newest-first, max 20 entries
- Each line: `[date title](../memory/YYYY/MM/DD/slug.md) — created: ..., accessed: ...`

### Scripts (plugin, at `${CLAUDE_PLUGIN_ROOT}/scripts/`)
| Script | Usage |
|---|---|
| `stamp-memory.js` | Initialize: create dirs + MEMORY.md, add `created`/`accessed`/`tier` to all files, scan & index |
| `touch-memory.js <path>` | Bump `accessed` to today. `--promote` to upgrade `tier: short` → `long`. |
| `prune-memory.js` | Enforce 20-entry cap + 90d eviction (short-term only, long-term protected). `--evict-stale`. |
| `compact.js` | Orchestrate compact mode. `--check`, `--execute --distilled <paths>`, `--validate`. |
| `rem-prep.js` | Pre-REM automation: event log, batch touch, auto-promote, compact check. `--transcript <path> --promote`. |

### Eviction

**Short-term (`tier: short`):**
- `accessed > 90 days` → evicted from index
- Index > 20 entries → drop oldest short-term first
- **Never delete `.claude/memory/` files** — only remove from the index

**Long-term (`tier: long`):**
- Checked each prune cycle: if `accessed < lastPruneTime` → demoted to `tier: short`
- Needs 2 inactive prune cycles to fully evict (demote → wait 90d → evict)
- Promoted back via `touch-memory.js --promote` when accessed again

**Safe to drop:**
- If content was extracted to a `.claude/rules/` file, the memory entry can be removed

### Rules vs Memory boundary
- **Rule** = what the model MUST do every session. Short, actionable.
- **Memory** = why, what happened, known bugs. Load on demand.
- Pointer pattern: `→ see .claude/memory/YYYY/MM/DD/slug.md`

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

**If compact needed:**

1. Read all files in `.claude/memory/`
2. Distill durable insights into `.claude/rules/rem/` rule files, organized by topic:
   - `.claude/rules/rem/hook.md` — hook behavior and guards
   - `.claude/rules/rem/api-proxy.md` — proxy gotchas and invariants
   - `.claude/rules/rem/takeover.md` — plugin architecture
   - etc. Group related memory topics under the same rule file.
3. Update any outdated rules already in `.claude/rules/rem/`
4. Run the cleanup script with the list of memory files you distilled:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compact.js --execute --distilled 2026/05/27/feedback_git_commit.md,2026/05/28/retrospect_hook_task_guard.md
```
This removes only the distilled entries from the index — un-distilled entries stay. Without `--distilled`, clears all entries (full reset).

5. Check documentation freshness:
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
- Scans transcript for `.claude/memory/` file reads → batch-touches `accessed` timestamps
- Checks git log on touched files → auto-promotes short-term entries with ≥3 commits to `tier: long`
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

## Cross-project check

If you modified files in OTHER git repos during this session, you MUST also update their `.claude/memory/` and `.claude/rules/MEMORY.md`. Check your transcript — you know which repos you touched.
