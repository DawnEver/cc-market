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
- [2026-06-10 sharp-review-cache-lag-failure](../memory/2026/06/10/sharp-review-cache-lag-failure.md) — `created: 2026-06-10, accessed: 2026-06-10`
- [2026-06-08 codex-reviewer-restored](../memory/2026/06/08/codex-reviewer-restored.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-08 deepseek-reviewer-added](../memory/2026/06/08/deepseek-reviewer-added.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-08 file-size-scope-added](../memory/2026/06/08/file-size-scope-added.md) — `created: 2026-06-08, accessed: 2026-06-08`
- [2026-06-07 sharp-review-2026-06-07](../memory/2026/06/07/sharp-review.md) — `created: 2026-06-07, accessed: 2026-06-07`
- [2026-06-04 sharp-review-workflow-bugs](../memory/2026/06/04/sharp-review-workflow-bugs.md) — `created: 2026-06-04, accessed: 2026-06-04`
- [2026-05-31 sharp-review-hook-provider-config](../memory/2026/05/31/sharp_review_hook_provider_config.md) — `created: 2026-05-31, accessed: 2026-05-31`
