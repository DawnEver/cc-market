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
├── hooks/
│   ├── hooks.json           Hook registration (SessionStart + Stop)
│   └── rem-hook.js          Stop hook: session-depth gate for /rem
├── scripts/
│   ├── lib.mjs              Shared library: paths, frontmatter, index, state, date, module inference, memory cross-reference
│   ├── stamp-memory.js      Initialize .claude/memory/ and MEMORY.md index
│   ├── inject-rules.js      SessionStart hook: inject host `.claude/rules/**/*.md` as additionalContext — Codex-only (Claude auto-loads them; no-op there)
│   ├── prune-memory.js      Evict stale short-term, demote inactive long-term
│   ├── touch-memory.js      Bump accessed timestamp, promote short→long
│   ├── compact.js           Distill memory into .claude/rules/rem/ (--check/--execute/--validate)
│   ├── rem-prep.js          Pre-REM scan: transcript parse, auto-bump, promotion candidates
│   ├── check-docs.js         Doc freshness check at compact time
│   ├── task-lib.mjs          Task pure logic: scan, parse, archive, report helpers
│   └── task-engine.js        Task CLI (todo): report, add, remove, mark, help
├── skills/
│   ├── rem/SKILL.md         /rem skill definition and workflow
│   └── todo/SKILL.md         /todo skill — user-facing task management
├── tests/
│   ├── frontmatter.test.mjs  frontmatter parsing, field get/set, tier, stamping
│   ├── date-path.test.mjs    date formatting, path resolution, memory dir security
│   ├── lib.test.mjs          index parsing, constants, file collection, state, findProjectRoot
│   ├── inject-rules.test.mjs host detection, rule-file collection, context build
│   └── rem-hook.test.mjs     isFreshSession, hasSubstantiveWork, decideStop
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md + @.claude/rules/*.md
└── AGENTS.md                This file
```

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for append-only, path security, frontmatter, index, and state constraints.

## Reference

Script flag reference and the `.claude/.rem-state.json` schema now live in
`skills/rem/reference/` (`scripts.md`, `state-schema.md`) — loaded on demand by `/rem`.

## Testing

```shell
node --test cc-market/rem/tests/*.test.mjs
```

Pre-commit hook runs all rem tests + takeover + sharp-review tests. Functions exported for testing: `decideStop`, `isFreshSession`, `hasSubstantiveWork`, `readTranscriptTail` from `rem-hook.js`; `findProjectRoot` and all other `lib.mjs` exports are public.

Test files: `frontmatter.test.mjs`, `date-path.test.mjs`, `lib.test.mjs`, `rem-hook.test.mjs`, `task-lib.test.mjs`, `check-docs.test.mjs`.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for paths, constants, and formats.
- **When memory entries are created or split**: update MEMORY.md, AGENTS.md, and README.md to reflect the new structure.
