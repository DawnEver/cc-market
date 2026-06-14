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

**Fixed durably (2026-06-14):** `db.mjs` `ensureColumns()` now backfills every missing
`sessions` column (`date`, token breakdown, `top_model`, `active_min`), and index creation
runs *after* it so `CREATE INDEX ON sessions(date)` can't fail on the old schema. Old DBs
now self-heal on open — no manual intervention needed.

Manual fallback if it ever recurs (DB is a pure cache of `~/.claude/projects/**/*.jsonl`):
`rm traceme.db traceme.db-wal traceme.db-shm` then `traceme rescan --all`. No data loss.

Note: the cached/installed plugin copy (`plugins/cache/cc-market/traceme/<ver>`) lags this
dev clone until it pulls, so the bug can still reproduce from there until then.
