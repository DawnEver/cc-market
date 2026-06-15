# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

```
Stop → sharp-review-hook.js
         ├── Wave gate: diff lastReviewRef..WORKTREE
         │     wave 0 (new commit): ≥300 lines or ≥5 files → pass
         │     wave 1+ (same ref):  ≥1000 lines or ≥15 files → pass
         │     Below threshold → skip (changes accumulate across sessions)
         ├── Classify (claude -p): none / once / multi
         └── Trigger /sharp-review skill:
               ├── diff-manifest.js → { mode, range, stats, diff?, manifestText?, excludedSummary }
               │     Smart filtering: lockfiles, generated, binary, pure renames
               │     mode = review (≤ inlineDiffLimit) | agent (> inlineDiffLimit) | empty (no files)
               ├── Workflow(sharp-review-workflow.js, { date, mode, range, stats, diff?, manifestText?, excludedSummary })
               │     ├── review mode: full diff inlined via takeover mode="review"
               │     └── agent mode: manifest only, reviewers explore via takeover mode="agent"
               ├── 2 of 3 reviewers, schema-constrained
               ├── Merge & dedup (≥2 reviewers = high confidence)
               └── post-review.js:
                     ├── Write .claude/memory/YYYY/MM/DD/sharp-review.md (single file w/ rem frontmatter)
                     └── stamp-memory.js → index in MEMORY.md

Generalized content review (external consumers):
  Caller → Workflow(sharp-review-workflow.js, { contentType: "content", content, reviewScope, findingSchema, reviewers, pickStrategy: "all", ... })
            ├── Parallel reviewers (all, configurable identities) with JSON Schema enforcement
            ├── Merge & dedup by configurable key fields
            └── Return { merged, markdown, summary } → caller handles pipeline integration
```

### Wave Gate

Reviews are gated by change accumulation, not per-session triggers. This prevents the "just reviewed, next stop triggers again" problem. Thresholds and config → `skills/sharp-review/SKILL.md`.

Implementation detail not covered there:
- `lastReviewRef` tracks which commit was last reviewed. Skipped sessions do NOT update it — changes keep accumulating.
- `lastReviewDiff` records the diff stat at the time of the last review. On same-ref checks, only the **delta** (current diff minus last reviewed diff) is compared against the threshold — preventing "one more file" from re-triggering after the threshold is already crossed.
- Ref vanished (rebase/gc): falls back to `HEAD~1`.

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
│   ├── diff-manifest.js              Analyze git diff → produce size-bounded manifest (review/agent/empty mode)
│   ├── post-review.js                Write memory entry → stamp
│   └── sharp-review-workflow.js   Review workflow (2 parallel reviewers, invoked by skill only)
├── lib.mjs                       SR-specific logic: frontmatter, markdown parsing, category inference, diff manifest
├── tests/                        Tests (node:test)
│   ├── lib.test.mjs              Frontmatter, category inference, markdown parsing
│   ├── manifest.test.mjs         Diff manifest: parsing, filtering, mode decision, rendering
│   ├── hook.test.mjs             Git root resolution
│   └── migrations.test.mjs       Legacy format migration
├── CLAUDE.md                     Entry point
├── AGENTS.md                     This file
└── README.md                     User-facing docs
```

### Dual Review Modes

`review` (full diff inlined) vs `agent` (manifest only, reviewers explore via tools) vs `empty` (skip) — see `skills/sharp-review/SKILL.md` for the mode table, thresholds, and filtering rules.

### Generalized Content Review

The workflow engine supports arbitrary content review via `contentType: "content"`. This decouples the review orchestration (parallel fanout, schema enforcement, dedup merge, confidence tagging) from the review target (code diffs).

**External consumer example — ai-post 三方会审:**

```
ai-post /post-review
  ├── Defines 2 reviewer identities (读者代理人, 技术核查员) with custom finding schemas
  ├── Runs 2 Workflow(sharp-review-workflow.js, { contentType: "content", ... }) in parallel
  │     ├── Identity A: hook quality, AI-taste per paragraph, humor density, rhythm
  │     └── Identity B: code correctness, install steps, terminology, architecture accuracy
  ├── Each workflow returns { merged, markdown, summary }
  └── post-review synthesizes cross-identity verdict (✅/⚠️/❌) + platform overview
```

Full parameter reference → `skills/sharp-review/SKILL.md` § Generalized Mode.

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for diff manifest, workflow args, dual-mode, schema, finding ID, and resolution constraints.

- **Report**: `todo` / `todo report` scans all memory files on the fly — never stale.

## Task System

Sharp-review owns findings end-to-end. `post-review.js` writes `sharp-review.md` and stamps memory — no delegation to `task-engine.js`. The `todo` CLI (owned by rem) scans memory files on the fly for reporting.

Full file-ownership table → `skills/sharp-review/reference/task-system.md`.

## Testing

```shell
node --test cc-market/sharp-review/tests/*.test.mjs
```

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- Keep `lib.mjs` as the single source of truth for constants and shared logic.
