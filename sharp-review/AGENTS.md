# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings written as a single memory entry `.claude/memory/YYYY-MM-DD/sharp-review.md` with rem frontmatter, synced to `.claude/memory/tasks/tasks.md`.

## Architecture

```
Stop → sharp-review-hook.js (classify: none/once/multi)
         ↓
     /sharp-review skill:
       ├── git diff → Workflow(sharp-review-workflow.js, { diff, date })
       ├── 3 parallel schema-constrained reviewers
       ├── Merge & dedup (≥2 reviewers = high confidence)
       └── post-review.js:
             ├── Write .claude/memory/YYYY-MM-DD/sharp-review.md (single file w/ rem frontmatter)
             ├── Memory cross-reference (SR-ID ↔ .claude/memory/)
             ├── stamp-memory.js → index in MEMORY.md
             └── Delegate to rem/scripts/task-engine.js
                   ├── Generate .claude/memory/tasks/tasks.md
                   ├── Archive resolved → tasks/archive/
                   └── Update .claude/rules/MEMORY.md
```

## File Structure

```
sharp-review/
├── .claude-plugin/plugin.json    Plugin manifest
├── .claude/rules/invariants.md   Always-injected constraints
├── hooks/
│   ├── hooks.json                Hook registration (Stop)
│   └── sharp-review-hook.js      Stop hook: classify review depth
├── skills/sharp-review/SKILL.md /sharp-review skill definition
├── scripts/
│   ├── post-review.js                Write workflow result as memory entry → stamp → task-engine
│   └── sharp-review-workflow.js   Review workflow (3 parallel agents, invoked by skill only)
├── lib.mjs                       SR-specific logic: module/category inference, memory cross-reference, frontmatter generation
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
- **Resolution**: Edit `**Status:** OPEN` → `**Status:** FIXED` directly in the memory file.

## Task System

Task management output (tasks.md, archive, MEMORY.md) is owned by `rem`. Sharp-review's `post-review.js` writes a single memory entry with rem frontmatter, cross-links SR-IDs, stamps memory — then delegates clean task objects to `rem/scripts/task-engine.js` for final output.

| File | Purpose |
|---|---|
| `.claude/memory/YYYY-MM-DD/sharp-review.md` | Single session review file with rem frontmatter |
| `.claude/memory/tasks/tasks.md` | Structured active task list (managed by rem) |
| `.claude/memory/tasks/archive/YYYY-MM.md` | Resolved task archive (managed by rem) |
| `.claude/rules/MEMORY.md` | Task index section (managed by rem) |

### Scale Detection (in rem engine)
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
