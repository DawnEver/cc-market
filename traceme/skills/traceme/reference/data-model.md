# TraceMe Data Model

Runtime reference for the traceme skill — billable-token math, schema, and category unit-split.

## Billable Basis

The canonical "tokens" metric across report/insights/dashboard/sync is
`input + output + cache_creation` (billable). Re-read cache (`cache_read`) is excluded from
headline totals and exposed as its own dimension — it is the same context re-read each turn
and inflates an idle session.

- `billable_tokens` = `input + output + cache_creation`
- `cache_read_tokens` kept separate
- `total_tokens` (all four) retained for completeness
- Derived queries return `tokens`/`billable_tokens` plus `cache_read`
- Daily snapshots carry `billable_tokens` + `cache_read_tokens`; merged reads fall back to
  `total_tokens` for snapshots an older device hasn't re-pushed

## Schema (all per-session, recomputed on each scan)

| Table | Content |
|-------|---------|
| `sessions` | One row per transcript: timestamps, counts, `active_min`, `repo_origin` |
| `session_models` | Per-model token breakdown per session |
| `session_tools` | Per-tool call counts per session |
| `session_skills` | Per-skill call counts per session |
| `session_categories` | Tool-category buckets for dashboard Plugins/Subagents/MCPs view |
| `daily_takeover` | Takeover NDJSON trace (only non-transcript source) |
| `traceme_meta` | Scan cursors (`cur:<path>`), cwd-to-repo cache (`repo:<cwd>`), `device_id`, sync timestamps |

## session_categories — Two Distinct Units

`session_categories` buckets by tool category. **Never sum these units:**

- `subagent.tokens` — *true* tokens of sidechain (subagent) assistant turns
- `mcp` / `plugin` / `builtin` — carry no real tokens; their `tool_result`-size estimate
  (`length/4`) lives in a separate `bytes_est` column (no per-tool token attribution exists
  in the transcript)

Local-device only; not synced.

## sessions.active_min

Hands-on time: sum of consecutive message-timestamp gaps under a 10-min idle cutoff (derived
in `scan.mjs`). Unlike elapsed (`ended_at - started_at`), idle gaps don't count — reports
surface both ("Active" vs "Elapsed"). Synced (in per-session snapshot rows) so cross-device
insights aggregate it; foreign snapshots predating the field contribute 0 until re-pushed.

## Project Identity

- Project display name = git repo basename of the transcript's `cwd`
- `repo_origin` = normalized git remote (cached per cwd) — the **grouping identity**.
  Report/insights/dashboard group by `repo_origin` so two repos sharing a basename don't merge.
  The dashboard suffixes the remote tail (`name (tail)`) when one basename maps to >1 remote.
- Remote-less repos share `''` and still merge (no identity without a remote).
