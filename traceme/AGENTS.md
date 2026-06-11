# TraceMe — AGENTS.md

Local-first personal observability for Claude Code. Tracks token usage, cost, tool usage, and session patterns across projects. Generates daily markdown reports.

## Architecture

Claude Code hooks capture session/tool/prompt events in real-time. At session end, the transcript JSONL is parsed to extract per-API-request token counts and model info. Cost is calculated from known model pricing. Everything stored in SQLite via `node:sqlite` (zero npm deps).

```
SessionStart → capture git branch, project name
UserPromptSubmit → record prompt text + timestamp
PreToolUse → record tool name + summary
SessionEnd → parse transcript JSONL, backfill token/cost, update daily summary
```

## File Map

| File | Role |
|------|------|
| `hooks/traceme-hook.js` | Reads stdin JSON, routes by event type, writes to DB; sync push at session end |
| `hooks/hooks.json` | Registers SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd |
| `scripts/db.mjs` | SQLite wrapper: schema, CRUD, queries |
| `scripts/ingest.mjs` | Transcript JSONL parser: extracts api_request token/cost data |
| `scripts/report.mjs` | Markdown report generator: per-project stats, top prompts, tool/skill usage |
| `scripts/traceme-cli.mjs` | CLI: report, stats, sync (setup/push/pull/verify/status), export, prune |
| `scripts/lib.mjs` | Shared: git helpers, paths, constants |
| `skills/traceme/SKILL.md` | `/traceme` slash command |
| `tests/` | Node built-in test runner, 32 tests across 5 suites |

## Data Flow

1. Hook → `traceme-hook.js` → `db.mjs` → `~/.claude/traceme/traceme.db`
2. SessionEnd → `ingest.mjs` parses transcript → backfills token/cost → updates daily_summary, then `sync.mjs` pushes per-device file to main (no aggregate step needed)
3. CLI/Skill → `report.mjs` → reads all device files in the date directory from cached `origin/main`, merges in memory; falls back to local SQLite (`db.mjs` queries) when no synced data exists for the date or `--local` is passed. Top Expensive Prompts is always local-only (prompt text is never synced).

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
traceme prune [days] [--keep-stats] Delete prompt text older than N days (default: 90)
```

`traceme report`/`traceme stats` read all device files in the date directory from the
cached `origin/main` ref by default (via `sync.readMergedSnapshot`) and merge in memory,
labeling output with the contributing devices. Pass `--local` to force local-SQLite-only
output (e.g. before any sync has run, or to inspect just this device's data).

`traceme sync status` shows sync health: encryption key fingerprint, remote URL, local repo
status, and `last_push`/`last_pull` timestamps. `traceme export [date] [--csv]` exports daily
per-project aggregates as JSON or CSV — prompt text is never included per privacy invariant.

Auto-sync runs at the end of Stop/SessionEnd processing in `hooks/traceme-hook.js` — pushes
today's per-device snapshot directly to `main`. Report reads all device files in the date
directory and merges in memory. No separate aggregate step needed. Remote resolves from
`TRACEME_SYNC_REMOTE` env var, falling back to the sync repo's `origin` if unset.

### Key Files
| File | Role |
|------|------|
| `scripts/crypto.mjs` | Zero-dep AES-256-GCM encryption (Node `crypto`, no external CLI) |
| `scripts/sync.mjs` | Sync engine: dump, encrypt, push, pull, decrypt, merge, verify, backfill, `readMergedSnapshot` |
| `scripts/migrate-legacy-paths.mjs` | One-time, manual: re-paths existing remote `YYYY-MM-DD.enc` snapshots to `YYYY/MM/DD.enc`. Not part of the CLI — `node scripts/migrate-legacy-paths.mjs` |
| `~/.claude/traceme/key.txt` | Symmetric key (hex, never committed, gitignored) |
| `~/.claude/traceme/sync-repo/` | Local clone of traceme-history repo |

### Environment, Key Sharing & Privacy

Env vars, multi-device key sharing steps, and the sync data model (what's synced vs.
excluded) → `skills/traceme/reference/sync.md`.

## Invariants

- Hooks never block — always exit 0. Errors logged to `~/.claude/traceme/error.log`
- DB at `~/.claude/traceme/traceme.db` — outside git repo, local only
- Zero npm dependencies — uses Node 24 `node:sqlite` built-in
- Prompt text stored locally only — not included in any sync/export path
- Sync repo contains ONLY `.enc` files — no plaintext ever touches GitHub
- Project = git repo basename of `cwd` at session start

## Tests

```bash
node --test cc-market/traceme/tests/*.test.mjs
```

32 tests: DB CRUD (10), transcript ingest (1), report incl. merged-vs-local (6), crypto (9), sync dump/import/merged (6).
