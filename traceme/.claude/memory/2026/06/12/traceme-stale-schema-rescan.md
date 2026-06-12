---
name: traceme-stale-schema-rescan
description: traceme rescan fails "no such column: date" when on-disk DB has pre-0.3 schema; fix is delete DB + rescan --all
metadata:
  type: reference
---

`traceme rescan --all` failed with `Error: no such column: date`. Root cause: the
on-disk `~/.claude/traceme/traceme.db` was created by an older traceme version whose
`sessions` table lacks `date` (plus `input_tokens`/`output_tokens`/`cache_*`/`top_model`).
traceme uses `CREATE TABLE IF NOT EXISTS`, which never migrates an existing table, so
`replaceSession`'s INSERT hits the missing column.

**Fix:** the DB is purely a cache of `~/.claude/projects/**/*.jsonl`, so it's safe to
`rm traceme.db traceme.db-wal traceme.db-shm` then `traceme rescan --all` to rebuild with
the current schema. No data loss.

Note this happened in the cached plugin copy (`plugins/cache/cc-market/traceme/<ver>`);
the dev clone of cc-market has no schema-migration guard, so it can recur on upgrade.
