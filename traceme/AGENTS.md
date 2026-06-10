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
| `hooks/ingest-hook.js` | Reads stdin JSON, routes by event type, writes to DB |
| `hooks/hooks.json` | Registers SessionStart, UserPromptSubmit, PreToolUse, SessionEnd |
| `scripts/db.mjs` | SQLite wrapper: schema, CRUD, queries |
| `scripts/ingest.mjs` | Transcript JSONL parser: extracts api_request token/cost data |
| `scripts/report.mjs` | Markdown report generator: per-project stats, top prompts, tool/skill usage |
| `scripts/traceme-cli.mjs` | CLI: `traceme report today`, `traceme stats`, `traceme setup` |
| `scripts/lib.mjs` | Shared: git helpers, paths, constants |
| `skills/traceme/SKILL.md` | `/traceme` slash command |
| `tests/` | Node built-in test runner, 32 tests across 5 suites |

## Data Flow

1. Hook → `ingest-hook.js` → `db.mjs` → `~/.claude/traceme/traceme.db`
2. SessionEnd → `ingest.mjs` parses transcript → backfills token/cost → updates daily_summary
3. CLI/Skill → `report.mjs` → `sync.readMergedSnapshot(date)` (cached `origin/main`, no network) for
   the cross-device aggregate; falls back to local SQLite (`db.mjs` queries) when no merged
   snapshot exists for the date or `--local-only` is passed. Top Expensive Prompts is always
   local-only (prompt text is never synced).

## Multi-Device Encrypted Sync

Each device is a git branch. Only `.enc` files (age-encrypted) touch the remote repo. The sync repo is separate from the config repo.

### Architecture
```
Device A (linxu-win)             GitHub (traceme-history)         Device B (linxu-mac)
     |                                |                                |
     | traceme sync push             |                                |
     | → dump SQLite → JSON          |                                |
     | → age encrypt                 |                                |
     | → git push device/linxu-win   |                                |
     |──────────────────────────────>|                                |
     |                                |                                |
     |                                |     traceme sync pull         |
     |                                |     → fetch device/*           |
     |                                |     → age decrypt              |
     |                                |     → merge into SQLite        |
     |                                |<───────────────────────────────|
     |                                |                                |
     | traceme sync aggregate        |                                |
     | → fetch all device branches   |                                |
     | → decrypt, merge, re-encrypt  |                                |
     | → push YYYY/MM/DD/cc.enc      |                                |
     |──────────────────────────────>|                                |
```

### Repo Structure (traceme-history)

Snapshot paths are `YYYY/MM/DD/cc.enc` — one directory per day, `cc.enc` holds the Claude Code
snapshot. The per-day directory leaves room for future sibling files (other tools' data) without
another path redesign. Same convention on device branches and `main`:
```
device/linxu-win/
  2026/06/09/cc.enc
  2026/06/10/cc.enc

device/linxu-mac/
  2026/06/09/cc.enc

main:
  2026/06/09/cc.enc    ← all-device aggregate
```

### Commands
```
traceme sync setup             Generate keypair, init sync repo, auto-pull from other devices
traceme sync push [date|--all] Encrypt & push daily snapshot (--all: backfill all history)
traceme sync pull [date|--all] Pull & import from other devices (--all: full sync)
traceme sync aggregate [date]  Merge all devices → push encrypted merge to main
traceme sync verify [date]     Compare local SQLite vs merged aggregate
```

`traceme report`/`traceme stats` read the cross-device `YYYY/MM/DD/cc.enc` aggregate from the
cached `origin/main` ref by default (via `sync.readMergedSnapshot`), labeling output with the
contributing devices. Pass `--local-only` to force local-SQLite-only output (e.g. before any
sync has run, or to inspect just this device's data).

Auto-sync: `hooks/sync-hook.js` fires on Stop/SessionEnd — pushes today's snapshot, then
re-aggregates all device branches into `main`. No manual push or separate aggregate cron
needed. Remote resolves from `TRACEME_SYNC_REMOTE` env var, falling back to the sync repo's
`origin` if unset.

### Key Files
| File | Role |
|------|------|
| `scripts/crypto.mjs` | Zero-dep AES-256-GCM encryption (Node `crypto`, no external CLI) |
| `scripts/sync.mjs` | Sync engine: dump, encrypt, push, pull, decrypt, merge, aggregate, verify, backfill, `readMergedSnapshot` |
| `scripts/migrate-legacy-paths.mjs` | One-time, manual: re-paths existing remote `YYYY-MM-DD.enc` snapshots to `YYYY/MM/DD.enc`. Not part of the CLI — `node scripts/migrate-legacy-paths.mjs` |
| `hooks/sync-hook.js` | Auto-sync hook: fires on session end, pushes today's snapshot and aggregates to `main` |
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
