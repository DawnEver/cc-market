# Memory Conventions (global, all projects)

## Three-tier loading
| Tier | When | Content | Eviction |
|---|---|---|---|
| `.claude/rules/*.md` | Always injected | Core behavioral constraints ALL agents must follow. Keep under ~10 lines. | Never (hand-curated) |
| Long-term memory (`tier: long`) | On-demand, progressive disclosure via MEMORY.md | Frequently accessed/updated memories. Promoted from short-term. | Immune to 90d eviction |
| Short-term memory (`tier: short`) | On-demand, progressive disclosure via MEMORY.md | Session notes, one-off fixes, historical reference. | 90d eviction window |

**Promotion:** Each memory file tracks `access_count` — incremented whenever `bumpAccessed`
advances `accessed` to a new date (same-day re-touches don't count). Once `access_count >= 3`,
`rem-prep.js --promote` automatically sets `tier: long`. To promote manually:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/touch-memory.js <path> --promote
```
This sets `tier: long`, making it immune to eviction.

## Memory file format
```yaml
---
name: kebab-case-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
created: YYYY-MM-DD
accessed: YYYY-MM-DD
tier: short | long
access_count: 1
---
```
- `created` — parent folder date
- `accessed` — bumped by `touch-memory.js`/`rem-prep.js` whenever referenced in a session
- `tier` — `short` by default; promoted to `long` automatically once `access_count >= 3`, or manually via `touch-memory.js --promote`
- `access_count` — number of distinct days this file was referenced; defaults to 1, auto-managed

## Index (`.claude/rules/MEMORY.md`)
- Sorted by `accessed` newest-first, max 20 entries
- Each line: `[date title](../memory/YYYY/MM/DD/slug.md) — created: ..., accessed: ...`

## Scoped memory (monorepo / multi-project)

Any directory containing its own `.claude/memory/` is an independent memory **scope**
with its own `MEMORY.md` index, its own 20-entry cap, and its own prune cycle —
e.g. each `cc-market/<plugin>/` alongside the repo root.

- `findMemoryScope()` walks up from `cwd` to the nearest ancestor (within
  `CLAUDE_PROJECT_DIR`) containing `.claude/memory/` — that's `scopeRoot` /
  `scopeMemoryDir` / `scopeIndexFile`, the scope `touch-memory.js`,
  `prune-memory.js`, and `compact.js` operate on by default.
- `findAllScopes()` walks the whole repo tree to find *every* `.claude/memory/`
  directory — used by `rem-prep.js` to locate a touched file regardless of which
  scope it lives in.
- The root `MEMORY.md` keeps a hand-maintained `## Scoped` section pointing to each
  sub-scope's `MEMORY.md` (e.g. `REM plugin → see cc-market/rem/.claude/rules/MEMORY.md`),
  so a session at the root knows where related memory lives. When adding a new
  sub-project with its own `.claude/memory/`, add a line here.
- `/rem` always operates on the scope for the **current working directory** — if you
  modified files in another scope this session, run prune/rem-prep/stamp for that
  scope too (see "Cross-project check" in SKILL.md).

## Eviction

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

## Rules vs Memory boundary
- **Rule** = what the model MUST do every session. Short, actionable.
- **Memory** = why, what happened, known bugs. Load on demand.
- Pointer pattern: `→ see .claude/memory/YYYY/MM/DD/slug.md`
