# TraceMe — AGENTS.md

Local-first personal observability for Claude Code. Tracks token usage, cost, tool usage, and session patterns across projects. Generates daily markdown reports.

## Architecture

The Claude Code transcripts at `~/.claude/projects/**/*.jsonl` are the source of truth —
every assistant message carries its model and full `usage` (input/output/cache), every
`tool_use` block names the tool, and each line carries `cwd`/`gitBranch`/`timestamp`. TraceMe
does **not** record any of this via real-time hooks; it scans the transcripts and derives
everything. The only thing the transcript lacks is the git remote (for cross-device repo
dedup), resolved per `cwd` via git and cached. Derived facts land in SQLite (`node:sqlite`,
zero npm deps); all reports are query-time aggregates — no additive bookkeeping. **Cost is
query-time too:** derived queries price the stored token components with the *current*
`model_pricing.json` via `calcCost`, so a pricing edit takes effect immediately — no rescan. The
scan-time `*_cost` columns are kept only as a fallback for rows with no per-model breakdown.

```
SessionStart → pull cross-device snapshots
Stop/SessionEnd → scanAll(): incremental sweep of all transcripts → replace session rows
                → fold in takeover traces → push encrypted daily snapshot (throttled)
```

## File Map

| File | Role |
|------|------|
| `hooks/traceme-hook.js` | SessionStart pulls; Stop/SessionEnd scans transcripts + pushes |
| `hooks/hooks.json` | Registers SessionStart, Stop, SessionEnd |
| `scripts/scan.mjs` | Incremental transcript scanner: per-file (size:mtime) cursor, message-id dedup, derives session/model/tool/skill facts |
| `scripts/db.mjs` | SQLite wrapper: schema, `replaceSession`, derived queries |
| `scripts/ingest.mjs` | Takeover NDJSON trace scanner (only non-transcript source) |
| `scripts/report.mjs` | Markdown report generator: per-project stats, model/tool usage |
| `scripts/commands/dashboard.mjs` | `dashboard` command: interactive HTML dashboard — embeds a 90-day flat fact table + per-device synced facts, renders/filters client-side with ECharts (CDN) incl. all-devices vs. single-device view; `buildDashboardHtml` exported for tests |
| `scripts/traceme-cli.mjs` | CLI: report, stats, sync, export, rescan, insights, dashboard |
| `scripts/lib.mjs` | Shared: git helpers, paths, constants |
| `skills/traceme/SKILL.md` | `/traceme` slash command |
| `tests/` | Node built-in test runner, 34 tests across 5 suites |

## Data Flow

1. Stop/SessionEnd → `scan.mjs` sweeps `~/.claude/projects/**/*.jsonl`. Unchanged files skip
   via cursor; changed files are fully re-parsed and the session's rows replaced
   (idempotent). Aggregates (`daily_summary`, model/tool/skill breakdowns) are derived at
   query time from the per-session tables.
2. After scan, `sync.mjs` pushes the per-device daily snapshot to `main` (throttled on Stop,
   forced on SessionEnd).
3. CLI/Skill → `report.mjs` → reads all device files in the date directory from cached
   `origin/main`, merges in memory; falls back to local SQLite queries when no synced data
   exists or `--local` is passed.

`sessions.active_min` is hands-on time: the sum of consecutive message-timestamp gaps under a
10-min idle cutoff (derived in `scan.mjs`). Unlike elapsed (`ended_at − started_at`), idle gaps
don't count — reports surface both ("Active" vs "Elapsed"). Local-only; not synced.

Schema (all per-session, recomputed on each scan): `sessions` (one row per transcript) +
`session_models` / `session_tools` / `session_skills` / `session_categories` breakdowns.
`session_categories` buckets by tool category for the dashboard's Plugins/Subagents/MCPs view.
**Two distinct units, never summed:** `subagent.tokens` are the *true* tokens of sidechain
(subagent) assistant turns; `mcp`/`plugin`/`builtin` carry no real tokens — their
`tool_result`-size estimate (`length/4`) lives in a separate `bytes_est` column (no per-tool
token attribution exists in the transcript). Local-device only; not synced.

**Billable basis:** the canonical "tokens" metric across report/insights/dashboard/sync is
`input + output + cache_creation` (billable) — re-read cache (`cache_read`) is excluded from
headline totals and exposed as its own dimension, since it is the same context re-read each turn
and inflates an idle session. `total_tokens` (all four) is retained for completeness; derived
queries return `tokens`/`billable_tokens` (billable) plus `cache_read`. Daily snapshots carry
`billable_tokens` + `cache_read_tokens`; merged reads fall back to `total_tokens` for snapshots an
older device hasn't re-pushed. `daily_takeover`
holds the only non-transcript source. `traceme_meta` holds scan cursors (`cur:<path>`), the cwd→repo
cache (`repo:<cwd>`), `device_id`, and sync timestamps.

## Multi-Device Encrypted Sync

All devices push per-device `.enc` files directly to `main`. Only `.enc` files (age-encrypted) touch the remote repo. The sync repo is separate from the config repo.

### Architecture
```
Device A (linxu-win)             GitHub (traceme-history)         Device B (linxu-mac)
     |                                |                                |
     | traceme sync push             |                                |
     | → dump SQLite → JSON          |                                |
     | → age encrypt                 |                                |
     | → push main:YYYY/MM/DD/       |                                |
     |        linxu-win.enc          |                                |
     |──────────────────────────────>|                                |
     |                                |                                |
     |                                |     traceme sync pull         |
     |                                |     → fetch main               |
     |                                |     → decrypt linxu-win.enc    |
     |                                |     → merge into SQLite        |
     |                                |<───────────────────────────────|
```

### Repo Structure (traceme-history)

Snapshot paths are `YYYY/MM/DD/<device-name>.enc` — one directory per day, one `.enc` file per
device. The per-day directory leaves room for future sibling files (other tools' data) without
another path redesign. All devices push directly to `main`:
```
main:
  2026/06/09/
    linxu-win.enc
    linxu-mac.enc
  2026/06/10/
    linxu-win.enc
    linxu-mac.enc
```

### Commands
```
traceme sync setup             Generate keypair, init sync repo, auto-pull from other devices
traceme sync push [date|--all] Encrypt & push daily snapshot (--all: backfill all history)
traceme sync pull [date|--all] Pull & import from other devices (--all: full sync)
traceme sync verify [date]     Compare local SQLite vs merged aggregate
traceme sync status            Show encryption key, remote, and sync health (last_push/last_pull)
traceme export [date] [--csv]  Export daily summaries as JSON or CSV
traceme rescan [--all] [--prune] Re-derive sessions from transcripts (--all: full rebuild; --prune: drop stale)
```

`traceme report`/`traceme stats` read all device files in the date directory from the
cached `origin/main` ref by default (via `sync.readMergedSnapshot`) and merge in memory,
labeling output with the contributing devices. Pass `--local` to force local-SQLite-only
output (e.g. before any sync has run, or to inspect just this device's data).

`traceme sync status` shows sync health: encryption key fingerprint, remote URL, local repo
status, and `last_push`/`last_pull` timestamps. `traceme export [date] [--csv]` exports daily
per-project aggregates as JSON or CSV. `traceme rescan` re-derives the local DB from the
transcripts (`--all` ignores cursors for a full rebuild; `--prune` drops sessions whose
transcript no longer exists) — safe to run anytime since all data is jsonl-derived.

Auto-sync runs at the end of Stop/SessionEnd processing in `hooks/traceme-hook.js` — pushes
today's per-device snapshot directly to `main`. Report reads all device files in the date
directory and merges in memory. No separate aggregate step needed. Remote resolves from
`TRACEME_SYNC_REMOTE` env var, falling back to the sync repo's `origin` if unset.

The snapshot carries `daily_summary` (incl. `billable_tokens`/`cache_read_tokens`), `tool_usage`,
`model_facts` (per project×model components — lights up cross-device per-model views), and
`sessions`. `merge.mjs` has ONE low-level reader, `loadDeviceSnapshots({from,to,skipSelf})`
(cached `origin/main`, no network); `readMergedSnapshot(date)` (per-day merge, for report/insights)
and `readDeviceFacts(from,to)` (per-device rows + per-device `modelFacts`, for the dashboard's
all-devices vs. single-device view) are both built on it. The local device is excluded from
`readDeviceFacts` — the live DB represents it, avoiding a double-count against its pushed snapshot.

### Key Files
| File | Role |
|------|------|
| `scripts/crypto.mjs` | Zero-dep AES-256-GCM encryption (Node `crypto`, no external CLI) |
| `scripts/sync.mjs` | Sync engine: dump, encrypt, push, pull, decrypt, merge, verify, backfill, `readMergedSnapshot`, `readDeviceFacts` |
| `scripts/migrate-legacy-paths.mjs` | One-time, manual: re-paths existing remote `YYYY-MM-DD.enc` snapshots to `YYYY/MM/DD.enc`. Not part of the CLI — `node scripts/migrate-legacy-paths.mjs` |
| `~/.claude/traceme/key.txt` | Symmetric key (hex, never committed, gitignored) |
| `~/.claude/traceme/sync-repo/` | Local clone of traceme-history repo |

### Environment, Key Sharing & Privacy

Env vars, multi-device key sharing steps, and the sync data model (what's synced vs.
excluded) → `skills/traceme/reference/sync.md`.

## Invariants

- Hooks never block — always exit 0. Errors logged to `~/.claude/traceme/error.log`
- DB at `~/.claude/traceme/traceme.db` — outside git repo, local only, fully rebuildable from transcripts via `rescan`
- Zero npm dependencies — uses Node 24 `node:sqlite` built-in
- Prompt text is **never** stored or read — the scanner only counts prompts; it never persists their content (structural guarantee, not a convention)
- Sync repo contains ONLY `.enc` files — no plaintext ever touches GitHub
- Project = git repo basename of the transcript's `cwd`; `repo_origin` = normalized git remote (cached per cwd)
- Scan is idempotent: a session is fully recomputed and replaced on each pass; aggregates are query-time only

## Tests

```bash
node --test cc-market/traceme/tests/*.test.mjs
```

53 tests: DB derived queries incl. billable basis, category unit-split, flat fact tables + `categorizeTool` (10), transcript scan incl. dedup/cursor/idempotence + category bucketing (5), report incl. merged-vs-local (7), crypto (9), sync dump/import/merged + `readDeviceFacts` (7), dashboard HTML builder — CDN/ECharts, fact-table payload, interactive controls incl. device dimension, data-honesty labels, JSON escaping (9), pricing model matching incl. dot/dash canonicalization + aliases (6), plus the shared `--test` run via pre-commit.
