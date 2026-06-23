# REM Scripts Reference

All scripts live at `${CLAUDE_PLUGIN_ROOT}/scripts/`.

| Script | Usage | Key Flags |
|---|---|---|
| `stamp-memory.js` | Initialize: create dirs + MEMORY.md, add `created`/`accessed`/`tier` to all files, scan & index | (none, idempotent) |
| `prune-memory.js` | Enforce 20-entry cap + 90d eviction (short-term only, long-term protected) | `--evict-stale`, `--dry-run` |
| `touch-memory.js <path>` | Bump `accessed` to today | `--promote` (upgrade `tier: short` → `long`) |
| `compact.js` | Orchestrate compact mode: distill memory into `.claude/rules/rem/` | `--check`, `--propose`, `--execute --distilled <paths>`, `--validate` |
| `scope-split.js` | Relocate a memory cluster into a child scope (move + tombstone), user-gated | `--check`, `--propose`, `--execute --scope <subdir> --entries <paths>` |
| `scope-validate.mjs` | Verify scope isolation + intermediate file integrity across all scopes | `--check`, `--fix` |
| `rem-prep.js` | Pre-REM automation: event log, batch touch, auto-promote, compact check | `--transcript <path>`, `--promote` |
| `check-docs.js` | Doc freshness check at compact time | `--json` |
| `task-engine.js` | Task CLI (`/todo`) | `report`, `add`, `remove`, `help` |
| `task-lib.mjs` | Task pure logic (library, not a CLI) | scan, parseExistingTasks, markFinding, groupBy* |
