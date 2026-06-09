# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

```
Stop → sharp-review-hook.js
         ├── Wave gate: diff lastReviewRef..WORKTREE
         │     wave 0 (new commit): ≥80 lines or ≥4 files → pass
         │     wave 1+ (same ref):  ≥300 lines or ≥10 files → pass
         │     Below threshold → skip (changes accumulate across sessions)
         ├── Classify (claude -p): none / once / multi
         └── Trigger /sharp-review skill:
               ├── git diff → Workflow(sharp-review-workflow.js, { diff, date })
               ├── 3 parallel schema-constrained reviewers
               ├── Merge & dedup (≥2 reviewers = high confidence)
               └── post-review.js:
                     ├── Write .claude/memory/YYYY/MM/DD/sharp-review.md (single file w/ rem frontmatter)
                     ├── stamp-memory.js → index in MEMORY.md
                     └── archiveResolved() → .claude/tasks/archive/YYYY/MM/DD.md
```

### Wave Gate

Reviews are gated by change accumulation, not per-session triggers. This prevents the "just reviewed, next stop triggers again" problem.

| State | Threshold | Purpose |
|---|---|---|
| wave 0 (new commit / first review) | Low (80L / 4F) | Catch issues early on fresh code |
| wave 1+ (same ref already reviewed) | High (300L / 10F) | Only re-trigger when substantial new changes accumulate |

- `lastReviewRef` tracks which commit was last reviewed. Skipped sessions do NOT update it — changes keep accumulating.
- `lastReviewDiff` records the diff stat at the time of the last review. On same-ref checks, only the **delta** (current diff minus last reviewed diff) is compared against the threshold — preventing "one more file" from re-triggering after the threshold is already crossed.
- Wave resets to 0 when HEAD moves to a new commit (new territory = early scrutiny).
- Ref vanished (rebase/gc): falls back to `HEAD~1`.

**Per-project configuration** (`.claude/.rem-state.json` → `reviewGate.thresholds`):
```json
{
  "wave0": { "lines": 80, "files": 4 },
  "wave1": { "lines": 300, "files": 10 }
}
```
Omit to use defaults. Partial override supported (e.g. only change `wave0.lines`).

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
│   ├── post-review.js                Write memory entry → stamp → archive resolved
│   └── sharp-review-workflow.js   Review workflow (3 parallel agents, invoked by skill only)
├── lib.mjs                       SR-specific logic: frontmatter, markdown parsing, category inference
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
- **Resolution**: Edit `**Status:** OPEN` → `**Status:** FIXED` in sharp-review.md, then `post-review.js --rescan` archives to `.claude/tasks/archive/YYYY/MM/DD.md`.
- **Report**: `todo` / `todo report` scans all memory files on the fly — never stale.

## Task System

Sharp-review owns findings end-to-end. `post-review.js` writes `sharp-review.md`, stamps memory, and directly archives resolved findings — no delegation to `task-engine.js`. The `todo` CLI (owned by rem) scans memory files on the fly for reporting.

| File | Purpose |
|---|---|
| `.claude/memory/YYYY/MM/DD/sharp-review.md` | Single session review file with rem frontmatter — sole source of truth |
| `.claude/tasks/archive/YYYY/MM/DD.md` | Resolved finding archive (daily files) |
| `.claude/rules/MEMORY.md` | Memory index — stamp-memory.js is sole maintainer (no separate Tasks section) |
| `.claude/memory/YYYY/MM/DD/manual.md` | Manual tasks (MANUAL-*) — created by `todo add`, rem frontmatter |

## Testing

```shell
node --test cc-market/sharp-review/tests/*.test.mjs
```

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for constants and shared logic.
