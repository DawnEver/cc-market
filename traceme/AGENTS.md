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

## Invariants

- Hooks never block — always exit 0. Errors logged to `~/.claude/traceme/error.log`
- DB at `~/.claude/traceme/traceme.db` — outside git repo, local only
- Zero npm dependencies — uses Node 24 `node:sqlite` built-in
- Prompt text stored locally only — not included in any sync/export path
- Project = git repo basename of `cwd` at session start

## Tests

```bash
node --test cc-market/traceme/tests/*.test.mjs
```

14 tests: DB CRUD (10), transcript ingest (1), report generation (3).
