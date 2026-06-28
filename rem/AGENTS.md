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
    ├── main loop: run user-gated crystallize/scope-split checks first (a fork can't prompt)
    ├── then dispatch a `fork` for the standard pass (inherits session context → first-hand summary,
    │   keeps prune/prep/stamp/memory-write noise out of the main session) → returns a one-line recap
    ├── rem-prep.js — scan transcript, bump accessed, suggest promotions
    ├── Model summarizes learnings → writes memory files
    ├── Update MEMORY.md index
    ├── If ≥20 entries → crystallize into .claude/rules/rem/
    │   └── check-docs.js — audit doc freshness after crystallization
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
├── scripts/        lib.mjs, stamp-memory.js, prune-memory.js, touch-memory.js, crystallize.js, scope-split.js,
│                   rem-prep.js, check-docs.js, inject-rules.js, task-engine.js, task-lib.mjs, scope-validate.mjs
├── skills/         rem/SKILL.md + todo/SKILL.md
├── tests/          *.test.mjs (see Testing section below)
├── .claude/rules/  invariants only
├── CLAUDE.md
└── AGENTS.md
```

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for append-only, path security, frontmatter, index, and state constraints.

## Host Behavior

Claude Code uses the Stop hook's non-zero slash-command injection convention to
auto-trigger `/rem` when the session is due for memory consolidation. Codex does
not use that convention for REM: when due, `rem-hook.js` exits successfully and
prints a reminder to invoke the rem skill directly, avoiding Codex hook failure
noise.

## Reference

Script flag reference, the `.claude/.rem-state.json` schema, and the (rare, user-gated) crystallize
procedure now live in `skills/rem/reference/` (`scripts.md`, `state-schema.md`, `crystallize.md`) —
loaded on demand by `/rem`.

## Testing

```shell
node --test cc-market/rem/tests/*.test.mjs
```

Pre-commit hook runs rem tests when rem files are staged. Functions exported for testing: `decideStop`, `isFreshSession`, `hasSubstantiveWork`, `readTranscriptTail` from `rem-hook.js`; `findProjectRoot` and all other `lib.mjs` exports are public.

Test files: `frontmatter.test.mjs`, `date-path.test.mjs`, `lib.test.mjs`, `rem-hook.test.mjs`, `task-lib.test.mjs`, `check-docs.test.mjs`, `scope-split.test.mjs`, `inject-rules.test.mjs`, `memory-state.test.mjs`, `migrations.test.mjs`, `scope-validate.test.mjs`, `task-engine-cli.test.mjs`.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for paths, constants, and formats.
- **When memory entries are created or split**: update MEMORY.md, AGENTS.md, and README.md to reflect the new structure.
