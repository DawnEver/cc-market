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
                → fold in fabric traces → push encrypted daily snapshot (throttled)
```

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File map** (every hook, script, module, tests) → `docs/architecture.md` § File Map.
- **Billable-token math, schema, `session_categories` unit-split, `active_min`** →
  `skills/traceme/reference/data-model.md`.
- **Multi-device encrypted sync architecture, snapshot data model, merge readers** →
  `skills/traceme/reference/sync.md`.
- **Dashboard full filter list** → `skills/traceme/reference/dashboard.md`.

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

## Invariants

- Hooks never block — always exit 0. Errors logged to `~/.claude/traceme/error.log`
- DB at `~/.claude/traceme/traceme.db` — outside git repo, local only, fully rebuildable from transcripts via `rescan`
- Zero npm dependencies — uses Node 24 `node:sqlite` built-in
- Prompt text is **never** stored or read — the scanner only counts prompts; it never persists its content (structural guarantee, not a convention)
- Sync repo contains ONLY `.enc` files — no plaintext ever touches GitHub
- Scan is idempotent: a session is fully recomputed and replaced on each pass; aggregates are query-time only
- Project grouping identity is `repo_origin` (normalized git remote), not basename. Remote-less repos share `''` and merge. Dashboard suffixes remote tail when one basename maps to >1 remote.

## Testing

```bash
node --test cc-market/traceme/tests/*.test.mjs
```

Coverage by suite: DB derived queries incl. billable basis, category unit-split, flat fact tables + `categorizeTool`; transcript scan incl. dedup/cursor/idempotence + category bucketing; report incl. merged-vs-local; crypto; sync dump/import/merged + `readDeviceFacts` + `mergeSkillFacts`/`mergeModelFacts`; dashboard HTML builder — CDN/ECharts, fact-table payload, interactive controls incl. device dimension, data-honesty labels, JSON escaping; pricing model matching incl. dot/dash canonicalization + aliases. Run via pre-commit hook for exact counts.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic. Export functions for testability where needed.
- Version bumping is automatic — the repo-level `pre-push` hook bumps this plugin's `plugin.json` whenever `traceme/` changed in the push.
