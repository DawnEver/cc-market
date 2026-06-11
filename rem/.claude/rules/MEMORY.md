# Memory Index

<!-- GENERATED — do not hand-edit. Rebuilt by rebuildIndex() on each session start,
     touch, prune, and stamp. Device-local (gitignored). -->

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)          — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)   — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run `node scripts/touch-memory.js <path> --promote` to upgrade short → long,
           or automatic when access_count >= 3 (rem-prep.js --promote)
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run `node scripts/prune-memory.js --evict-stale` (short-term eviction + long-term demotion check)
Compact:   run `node scripts/compact.js --check` when index grows large

Path format:  ../memory/YYYY/MM/DD/slug.md — nested per-day directories (required).

Frontmatter (content fields only):
  - name:        short kebab-case slug (required)
  - description: one-line summary (required)
  - metadata.type: user | feedback | project | reference (required)

Volatile metadata (accessed, count, tier, dropped) lives in gitignored
_memory/YYYY/MM/DD/_meta.json per date directory — never in frontmatter.
-->

## Entries
- [2026-06-11 scope-isolation](../memory/2026/06/11/scope-isolation.md) — `created: 2026-06-11, accessed: 2026-06-11`
- [2026-06-10 access-count-promotion](../memory/2026/06/10/access-count-promotion.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-10 traceme-sync-fix](../memory/2026/06/10/traceme-sync-fix.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-08 stamp-memory-truncated-date-bug](../memory/2026/06/08/stamp-memory-truncated-date-bug.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-07 docs-sync-rule](../memory/2026/06/07/docs-sync-rule.md) — `created: 2026-06-07, accessed: 2026-06-07`
- [2026-06-07 find-project-root](../memory/2026/06/07/find-project-root.md) — `created: 2026-06-07, accessed: 2026-06-07`
