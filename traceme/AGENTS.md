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
| `tests/` | Node built-in test runner, 14 tests across 3 suites |

## Data Flow

1. Hook → `ingest-hook.js` → `db.mjs` → `~/.claude/traceme/traceme.db`
2. SessionEnd → `ingest.mjs` parses transcript → backfills token/cost → updates daily_summary
3. CLI/Skill → `report.mjs` → queries DB → markdown to stdout

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
     | → push merged/ to main        |                                |
     |──────────────────────────────>|                                |
```

### Repo Structure (traceme-history)
```
device/linxu-win/
  2026-06-09.enc
  2026-06-10.enc

device/linxu-mac/
  2026-06-09.enc

main:
  merged/
    2026-06-09.enc    ← all-device aggregate
```

### Commands
```
traceme sync setup             Generate keypair, init sync repo, auto-pull from other devices
traceme sync push [date|--all] Encrypt & push daily snapshot (--all: backfill all history)
traceme sync pull [date|--all] Pull & import from other devices (--all: full sync)
traceme sync aggregate [date]  Merge all devices → push encrypted merge to main
traceme sync verify [date]     Compare local SQLite vs merged aggregate
```

Auto-push: `hooks/sync-hook.js` fires on Stop/SessionEnd — no manual push needed.

### Key Files
| File | Role |
|------|------|
| `scripts/crypto.mjs` | Zero-dep AES-256-GCM encryption (Node `crypto`, no external CLI) |
| `scripts/sync.mjs` | Sync engine: dump, encrypt, push, pull, decrypt, merge, aggregate, verify, backfill |
| `hooks/sync-hook.js` | Auto-push hook: fires on session end, pushes today's snapshot |
| `~/.claude/traceme/key.txt` | Symmetric key (hex, never committed, gitignored) |
| `~/.claude/traceme/sync-repo/` | Local clone of traceme-history repo |

### Environment
- `TRACEME_SYNC_REMOTE` — Git remote URL for the sync data repo (required for push/pull/aggregate)
- `TRACEME_DEVICE_NAME` — Override device name (default: hostname)

### Multi-Device Key Sharing
All devices share the same symmetric key. After `traceme sync setup` on device A:
1. Copy `~/.claude/traceme/key.txt` to device B at the same path
2. Run `traceme sync setup` on device B (skips key gen, just inits repo)

### Sync Data Model (what gets synced)
- `daily_summary` table (per-project aggregates: tokens, cost, sessions)
- `sessions` metadata (id, project, branch, timestamps, counts — NO prompt text, NO paths)
- `tool_usage` / `skill_usage` aggregated counts

Prompt text and project paths are excluded per the privacy invariant.

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

27 tests: DB CRUD (10), transcript ingest (1), report (3), crypto (9), sync dump/import (4).
