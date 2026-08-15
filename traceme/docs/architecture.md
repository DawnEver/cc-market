# TraceMe — Architecture (deep detail)

Deep-detail reference for the traceme plugin. Loaded on demand from `AGENTS.md` §
Orientation when a task reaches into this area — not always-loaded entry-point content.

## File Map

| File | Role |
|------|------|
| `hooks/traceme-hook.js` | SessionStart pulls; Stop/SessionEnd scans transcripts + pushes |
| `hooks/hooks.json` | Registers SessionStart, Stop, SessionEnd |
| `scripts/scan.mjs` | Incremental transcript scanner: per-file (size:mtime) cursor, message-id dedup, derives session/model/tool/skill facts |
| `scripts/db.mjs` | SQLite wrapper: schema, `replaceSession`, derived queries |
| `scripts/ingest.mjs` | Fabric provider NDJSON trace scanner (only non-transcript source) |
| `scripts/report.mjs` | Markdown report generator: per-project stats, model/tool usage |
| `scripts/commands/dashboard.mjs` | `dashboard` command: interactive HTML dashboard — embeds a 90-day flat fact table + per-device synced facts, renders/filters client-side with ECharts (CDN) incl. all-devices vs. single-device view; `buildDashboardHtml` exported for tests |
| `scripts/traceme-cli.mjs` | CLI: report, stats, sync, export, rescan, insights, dashboard |
| `scripts/lib.mjs` | Shared: git helpers, paths, constants |
| `skills/traceme/SKILL.md` | `/traceme` slash command |
| `tests/` | Node built-in test runner — see `node --test traceme/tests/*.test.mjs` |
| `docs/architecture.md` | Deep-detail reference (this file) |
