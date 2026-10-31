---
name: memory-converges-on-the-tree
description: rem keeps no per-entry state; reading never writes, the index is derived, and an entry retires when a live entry names it in merged_from
created: 2026-10-31
merged_from:
  - 2026/06/10/access-count-promotion.md
metadata:
  type: project
---

# Memory converges on the tree (2026-10-31)

User ask: "rethink and refactor the memory system: it broke under high concurrency, and memories
pile up like mountains." Autonomy granted; decisions recorded here.

## Measured (motronics-studio, the heaviest consumer, 2026-10-31)

- 2,993 tracked entries; 2,914 live in the root scope. Oct 2026 alone added 1,942.
- 82 entries indexed across 12 scopes (2.7%); nothing ever deleted a file — "eviction" only
  wrote `dropped: stale-90d` into a gitignored `_meta.json` (105 such tombstones).
- `_meta.json` covered 149 of 2,993 entries: access tracking was per-worktree, gitignored, and
  effectively empty, yet recall wrote it on every injected prompt (`bumpAccessed`, lock
  `onTimeout: 'proceed'`, i.e. unlocked under contention).
- 1,596 entries carry `accessed:` in tracked frontmatter (dev-lab's REPORTS-LIVE-IN-MEMORY text
  asked for it) — a second, hand-written copy of the same non-fact; 1,499 entries were modified
  after creation in October (correction in place).
- `.claude/rules/MEMORY.md` was tracked until 2026-09-12 and conflicted in lane merges (five
  merge commits resolve it); now gitignored but still rewritten by every SessionStart prune.
- `atomicWriteFile` used a fixed `<file>.tmp`: four concurrent writers × 300 writes fail
  (measured; the new unique-temp writer passes the same test).
- 78 entries are already named in a live `merged_from` yet still on disk (merge never deleted).

## Design

- One source of truth: the dated file. Date = path. No `_meta.json`, no tiers, no counts, no
  catalog, no `prune` block in `.rem-state.json`.
- Never write on read: recall and rem-prep are read-only toward the repo.
- Derived index: `rebuildIndex()` is a pure function of the tree, written only when bytes change,
  so concurrent sessions converge without a lock. Hot set = user/feedback + newest 15.
- One lifecycle edge: `merged_from:` on a live entry retires what it names; `retire-memory.js`
  is the only deleter. Supersede (remember.js does it for a same-name entry), merge
  (merge-memory.js now deletes sources after a verbatim fold), crystallize (ledger entry naming
  the distilled entries and pointing at the rule).
- State saves are always tmp+rename with unique temp names (`shared/atomic-write.mjs`).
- One-shot migration: `rem/migrations/migrate.mjs [root] [--dry-run]`.

The access-count promotion design (2026-06-10) is superseded by this entry.
