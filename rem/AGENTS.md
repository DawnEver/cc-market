# REM Plugin — AGENTS.md

Memory management plugin for Claude Code sessions. Three-tier system: rules (always), long-term (progressive disclosure), short-term (90d eviction).

## Architecture

```
SessionStart → prune-memory.js --evict-stale
     ↓
 [Claude reads/writes .claude/memory/ files]
     ↓
  Stop → rem-hook.js (gates after ≥3 stops, ≥2 min)
     ↓
  /rem skill:
    ├── rem-prep.js — scan transcript, bump accessed, suggest promotions
    ├── Model summarizes learnings → writes memory files
    ├── Update MEMORY.md index
    ├── If ≥20 entries → compact into .claude/rules/rem/
    │   └── check-docs.js — audit doc freshness after compaction

  /todo skill (user-facing task management):
    ├── /todo        → task-engine.js --report
    ├── /todo add    → task-engine.js --add
    ├── /todo sync   → post-review.js → task-engine.js --findings
    ├── /todo resolve → edit .claude/memory/YYYY-MM-DD/sharp-review.md in-place
    └── /todo check  → task-engine.js --check
```

### Three tiers

| Tier | Location | Frontmatter | Loaded | Eviction |
|---|---|---|---|---|
| Rules | `.claude/rules/` | (none) | Every session | Never |
| Long-term | `.claude/memory/` | `tier: long` | On demand via index | Demoted if inactive between prune cycles |
| Short-term | `.claude/memory/` | `tier: short` | On demand via index | 90d since last `accessed` |

## File Structure

```
rem/
├── lib.mjs                  Shared library: paths, frontmatter, index, state, date, module inference, memory cross-reference
├── hooks/
│   ├── hooks.json           Hook registration (SessionStart + Stop)
│   └── rem-hook.js          Stop hook: session-depth gate for /rem
├── scripts/
│   ├── stamp-memory.js      Initialize .claude/memory/ and MEMORY.md index
│   ├── prune-memory.js      Evict stale short-term, demote inactive long-term
│   ├── touch-memory.js      Bump accessed timestamp, promote short→long
│   ├── compact.js           Distill memory into .claude/rules/rem/ (--check/--execute/--validate)
│   ├── rem-prep.js          Pre-REM scan: transcript parse, auto-bump, promotion candidates
│   ├── check-docs.js         Doc freshness check at compact time
│   └── task-engine.js        Task management engine: --findings, --add, --check, --report
├── skills/
│   ├── rem/SKILL.md         /rem skill definition and workflow
│   └── todo/SKILL.md         /todo skill — user-facing task management
├── tests/
│   ├── frontmatter.test.mjs  frontmatter parsing, field get/set, tier, stamping
│   ├── date-path.test.mjs    date formatting, path resolution, memory dir security
│   ├── lib.test.mjs          index parsing, constants, file collection, state, findProjectRoot
│   └── rem-hook.test.mjs     isFreshSession, hasSubstantiveWork, decideStop
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md + @.claude/rules/*.md
└── AGENTS.md                This file
```

## Key Invariants

See `.claude/rules/invariants.md` for the always-injected version.

- **Append-only**: Memory files are never deleted from disk. `prune-memory.js` removes from index only. `compact.js` clears index but keeps files.
- **Path security**: Use `resolveMemoryPath()` + `isInsideMemoryDir()` before any file I/O on user-supplied paths.
- **Frontmatter fields**: Every `.claude/memory/*.md` needs `name`, `description`, `created`, `accessed`, `tier`.
- **Index format**: `MEMORY.md` sorted by `accessed` descending, max 20 entries.
- **Unified state**: `.claude/.rem-state.json` holds both hook state and prune events.

## Scripts Quick Reference

| Script | Entry Point | Key Flags |
|---|---|---|
| `stamp-memory.js` | Initialize memory system | (none, idempotent) |
| `prune-memory.js` | Evict/demote | `--evict-stale`, `--dry-run` |
| `touch-memory.js` | Update timestamps | `--promote` |
| `compact.js` | Distill into rules | `--check`, `--execute`, `--validate`, `--distilled` |
| `rem-prep.js` | Pre-REM automation | `--transcript <path>`, `--promote` |
| `task-engine.js` | Task management engine | `--findings <json>`, `--check`, `--report` |
| `check-docs.js` | Doc freshness at compact | `--json` |

## State Management

`lib.mjs` exports `loadState()`, `saveState()`, `appendEvent()`. State file: `.claude/.rem-state.json`.

```json
{
  "hook": {
    "sessionKey": "uuid",
    "stopCount": 3,
    "firstStopAt": 1780500000000,
    "remPending": false,
    "remDone": false,
    "lastTouched": 1780500000000,
    "taskActiveUntil": null
  },
  "prune": {
    "lastPruneAt": 1780500000000,
    "events": [{ "ts": "...", "type": "evict", "path": "...", "reason": "stale-90d" }]
  }
}
```

## Testing

```shell
node --test cc-market/rem/tests/frontmatter.test.mjs
node --test cc-market/rem/tests/date-path.test.mjs
node --test cc-market/rem/tests/lib.test.mjs
node --test cc-market/rem/tests/rem-hook.test.mjs
```

Pre-commit hook runs all rem tests + takeover + sharp-review tests. Functions exported for testing: `decideStop`, `isFreshSession`, `hasSubstantiveWork`, `readTranscriptTail` from `rem-hook.js`; `findProjectRoot` and all other `lib.mjs` exports are public.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for paths, constants, and formats.
- **When memory entries are created or split**: update MEMORY.md, AGENTS.md, and README.md to reflect the new structure.
