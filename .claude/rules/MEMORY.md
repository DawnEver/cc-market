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

## Scoped

- rem → see rem/.claude/rules/MEMORY.md
- sharp-review → see sharp-review/.claude/rules/MEMORY.md
- takeover → see takeover/.claude/rules/MEMORY.md
- traceme → see traceme/.claude/rules/MEMORY.md
- watch → see watch/.claude/rules/MEMORY.md


## Entries
- [2026-06-10 agnets-md-vs-skill-md](../memory/2026/06/10/agents-md-vs-skill-md.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-10 dev-vs-runtime-context-invariant](../memory/2026/06/10/dev-vs-runtime-context-invariant.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-09 shared-bundle](../memory/2026/06/09/shared-bundle.md) — `created: 2026-06-09, accessed: 2026-06-09`
- [2026-06-09 sharp-review-2026-06-09](../memory/2026/06/09/sharp-review.md) — `created: 2026-06-09, accessed: 2026-06-09`
- [2026-06-08 cc-market-shared-extraction](../memory/2026/06/08/cc-market-shared-extraction.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-07 sharp-review-rem-unification](../memory/2026/06/07/sharp-review-rem-unification.md) — `created: 2026-06-07, accessed: 2026-06-07`
