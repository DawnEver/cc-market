# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings written to `.claude/sharp-review/YYYY-MM-DD.md` with stable IDs (SR-YYYYMMDD-NNN) and synced to `.claude/memory/tasks/tasks.md`.

## Architecture

```
Stop → sharp-review-hook.js (classify: none/once/multi)
         ↓
     /sharp-review skill:
       ├── git diff → Workflow(sharp-review.js, { diff, date })
       ├── 3 parallel schema-constrained reviewers
       ├── Merge & dedup (≥2 reviewers = high confidence)
       ├── Write .claude/sharp-review/YYYY-MM-DD.md
       ├── sync-tasks.js → .claude/memory/tasks/tasks.md
       └── sync-tasks.js → update MEMORY.md index
```

## File Structure

```
sharp-review/
├── .claude-plugin/plugin.json    Plugin manifest
├── .claude/rules/invariants.md   Always-injected constraints
├── hooks/
│   ├── hooks.json                Hook registration (Stop)
│   └── sharp-review-hook.js      Stop hook: classify review depth
├── skills/sharp-review/SKILL.md  /sharp-review skill definition
├── scripts/sync-tasks.js         Task sync engine
├── workflows/sharp-review.js     Review workflow (3 parallel agents)
├── lib.mjs                       Shared library
├── tests/                        Tests (node:test)
├── CLAUDE.md                     Entry point
├── AGENTS.md                     This file
└── README.md                     User-facing docs
```

## Key Invariants

See `.claude/rules/invariants.md` for the always-injected version.

- **Workflow args**: `{ diff, date }` required. No `Date.now()`/`new Date()` in workflow scripts.
- **Schema**: Must be `{ type: 'object', properties: { findings: [...] } }` — bare array fails silently.
- **Finding IDs**: `SR-YYYYMMDD-NNN`, assigned by workflow merge phase.
- **Memory cross-reference**: Findings that reference memory entries get SR-IDs written back using `[[SR-ID]]` notation.
- **Task sync**: `--resolve` persists IDs; `[x]` in tasks.md auto-promotes.

## Task System

| File | Purpose |
|---|---|
| `.claude/sharp-review/YYYY-MM-DD.md` | Raw review output |
| `.claude/sharp-review/resolved.txt` | Persistent resolved IDs |
| `.claude/memory/tasks/tasks.md` | Structured active task list |
| `.claude/memory/tasks/archive/YYYY-MM.md` | Resolved task archive |
| `.claude/rules/MEMORY.md` | Task index section |

### Scale Detection
- <10 open → flat list
- 10-50 → sectioned by category
- 50+ → split files (bugs.md, features.md, perf.md)

## Testing

```shell
node --test cc-market/sharp-review/tests/*.test.mjs
```

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for constants and shared logic.
