# REM Plugin — AGENTS.md

Memory management plugin for Claude Code sessions. Three-tier system: rules (always), long-term (progressive disclosure), short-term (90d eviction).

## Architecture

```
SessionStart → prune-memory.js --evict-stale
            → inject-rules.js (Codex-only: feed host .claude/rules into context)
     ↓
 [Claude reads/writes .claude/memory/ files]
     ↓
  Stop → rem-hook.js (gates after ≥3 stops AND (≥2 min session OR ≥30s + substantive code edits))
     ↓
  /rem skill:
    ├── rem-prep.js — scan transcript, bump accessed, suggest promotions
    ├── Model summarizes learnings → writes memory files
    ├── Update MEMORY.md index
    ├── If ≥20 entries → compact into .claude/rules/rem/
    │   └── check-docs.js — audit doc freshness after compaction
    ├── If scope large + a subdir owns a cluster → scope-split into a child scope (user-gated)

  /todo skill (user-facing task management):
    ├── /todo        → task-engine.js report  (scans memory directly)
    ├── /todo add    → task-engine.js add --summary "..."
    ├── /todo remove → task-engine.js remove <id>  (or close SR-*)
    ├── /todo mark   → task-engine.js mark <id> <open|fixed|closed>
    └── /todo check  → task-engine.js report  (report includes stats)
```

Three-tier memory system (rules / long-term / short-term) → `skills/rem/reference/memory-conventions.md`.

## File Structure

```
rem/
├── hooks/          hooks.json + rem-hook.js
├── scripts/        lib.mjs, stamp, prune, touch, compact, scope-split,
│                   rem-prep, check-docs, inject-rules, task-engine, task-lib
├── skills/         rem/SKILL.md + todo/SKILL.md
├── tests/          *.test.mjs (see Testing section below)
├── .claude/rules/  invariants only
├── CLAUDE.md
└── AGENTS.md
```

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for append-only, path security, frontmatter, index, and state constraints.

## Reference

Script flag reference, the `.claude/.rem-state.json` schema, and the (rare, user-gated) compact
procedure now live in `skills/rem/reference/` (`scripts.md`, `state-schema.md`, `compact.md`) —
loaded on demand by `/rem`.

## Testing

```shell
node --test cc-market/rem/tests/*.test.mjs
```

Pre-commit hook runs all rem tests + takeover + sharp-review tests. Functions exported for testing: `decideStop`, `isFreshSession`, `hasSubstantiveWork`, `readTranscriptTail` from `rem-hook.js`; `findProjectRoot` and all other `lib.mjs` exports are public.

Test files: `frontmatter.test.mjs`, `date-path.test.mjs`, `lib.test.mjs`, `rem-hook.test.mjs`, `task-lib.test.mjs`, `check-docs.test.mjs`, `scope-split.test.mjs`.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for paths, constants, and formats.
- **When memory entries are created or split**: update MEMORY.md, AGENTS.md, and README.md to reflect the new structure.
