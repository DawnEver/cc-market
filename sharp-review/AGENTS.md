# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

Full flow: Stop hook → classify → main loop dispatches **one worker subagent** → worker runs
`/sharp-review` Steps 1-6 → memory entry → worker returns only `Sharp review: <summary>`.
Diagram and per-step detail → **`skills/sharp-review/SKILL.md`** (see Execution-mode preamble).

### Subagent execution (context isolation)

The standard trigger runs the **entire** review inside a dispatched `general-purpose` worker
subagent, so none of the diff/reviewer/merge noise touches the main session — only the
one-line summary returns. Sharp review is context-independent (operates on git state), so a
fresh subagent suffices; rem, by contrast, needs session context and is offloaded via `fork`.
The worker still fans out reviewer subagents (Step 3b) — the recursion guard only forbids
spawning a *second worker* for the same skill. Codex, lacking a subagent type, runs the skill
inline.

### Fan-out (worker subagent / Codex + inline Workflow)

One merge/render, two fan-out tools. The standard path (worker subagent on Claude, or Codex)
has no `Workflow` tool, so it fans out reviewers directly and feeds `post-review.js --raw`.
Only an inline Generalized-Mode caller in the main loop uses the `Workflow` tool. Full
procedure → **`skills/sharp-review/SKILL.md`** Step 3 (3a Workflow / 3b direct →
**`reference/direct-fanout.md`**).

### Wave Gate

Reviews gated by change accumulation, not per-session. Thresholds, delta-comparison mechanics
(`lastReviewRef`/`lastReviewDiff`/ref-vanished fallback), and config keys →
**`skills/sharp-review/reference/profiles-and-modes.md`**.

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
│   ├── lib.mjs                   Barrel: re-exports lib/* + shared frontmatter helpers (stable `./lib.mjs`/`../scripts/lib.mjs` import path)
│   ├── lib/                      Concern modules:
│   │   ├── findings.mjs          Category inference, same-day follow-up renumber, host-agnostic mergeFindings/renderReviewMarkdown
│   │   ├── profiles.mjs          Profile registry (PROFILES) + weighted selection (resolveWeights/globalWeightsForSources/pickProfileKey)
│   │   ├── manifest.mjs          Diff-manifest: isLockfile/isDoc/classifyLowValue, git -z parsing, buildManifest, renderManifestText
│   │   └── config.mjs            loadReviewConfig — reads tracked .claude/sharp-review.json (profileWeights, customProfiles, thresholds, inlineDiffLimit, …)
│   ├── sources.mjs               Source-adapter registry (pure): diff | codebase | deps | docs trigger logic + evaluateSources
│   ├── pick-profile.js               Source-constrained weighted profile pick (--sources); stateless
│   ├── diff-manifest.js              Analyze git diff → produce size-bounded manifest (review/agent/empty mode)
│   ├── post-review.js                Write memory entry → stamp. `--raw` merges+renders raw per-reviewer findings via lib (host-agnostic entry, used by Codex / any non-Workflow-VM host); `--findings`+`--markdown` takes pre-merged input (Claude Workflow / external content callers)
│   └── sharp-review-workflow.js   Review workflow (2 parallel reviewers, invoked by skill only)
├── tests/                        Tests (node:test)
│   ├── lib.test.mjs              Frontmatter, category inference, markdown parsing
│   ├── merge-render.test.mjs     Host-agnostic mergeFindings/renderReviewMarkdown/buildDedupKey
│   ├── post-review-raw.test.mjs  post-review.js --raw end-to-end (raw fan-out → memory entry)
│   ├── manifest.test.mjs         Diff manifest: parsing, filtering, mode decision, rendering
│   ├── hook.test.mjs             Git root resolution
│   └── migrations.test.mjs       Legacy format migration
├── CLAUDE.md                     Entry point
├── AGENTS.md                     This file
└── README.md                     User-facing docs
```

### Review Profiles & Modes (design seam only)

Runtime facts — the profile table, weights, the orphan-mass weighting math, the mode
table/thresholds, and config keys — live in `skills/sharp-review/reference/profiles-and-modes.md`
(don't restate them here; they drift). What's dev-only:

- A profile is a review *template* (scope + prompt framing + forced mode) in `PROFILES`
  (`lib/profiles.mjs`), orthogonal to providers (seed-mod reviewer rotation unchanged). The
  **profile is the single unit of selection**; a `source` (`sources.mjs`) is just its trigger —
  no pick-source-then-profile two-step.
- `pick-profile.js --sources <fired>` does one global weighted draw via `globalWeightsForSources`.
- The seam is **additive**: the engine was already source-agnostic; only the entry layer
  (profiles + pick-profile + hook gate) was lifted onto it, so all profiles still write the same
  `sharp-review.md` with `SR-` ids and zero downstream changes.
- **Config vs runtime state are separate files** (don't merge them): static review config
  (`profileWeights`, `customProfiles`, `thresholds`, `inlineDiffLimit`, `docsThreshold`,
  `codebaseIntervalMin`) lives in the **tracked** `.claude/sharp-review.json` via
  `loadReviewConfig` (`lib/config.mjs`) so it's shareable; volatile runtime state stays in the
  gitignored `.claude/.rem-state.json` under `reviewGate`. `migrations/migrate.mjs` relocates
  legacy config out of `reviewGate` into the config file. `customProfiles` are config-declared
  review templates merged into `PROFILES` at pick time (`mergeProfiles`/`normalizeCustomProfile`)
  — a repo adds a profile without touching plugin code.

### Generalized Content Review

The workflow engine supports arbitrary content review beyond code diffs (parallel fanout,
schema enforcement, dedup merge, confidence tagging). Full parameter reference and external
consumer example (ai-post 三方会审) → **`skills/sharp-review/SKILL.md`** Generalized Mode →
**`reference/generalized-mode.md`**.

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
- Keep concern modules (`findings`/`profiles`/`manifest`) as the single source of truth for their logic; `lib.mjs` is only a re-export barrel. Add new shared logic to the matching module (or a new sibling), then export it through the barrel.
