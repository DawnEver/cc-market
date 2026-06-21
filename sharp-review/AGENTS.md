# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Three parallel reviewers with JSON Schema constraints, cross-checked and merged. Findings stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

```
Stop → sharp-review-hook.js
         ├── Source gate (sources.mjs evaluateSources, pure): the hook does the git/clock I/O,
         │     builds ctx, and asks every source adapter if it fired.
         │       diff     → wave gate (lastReviewRef..WORKTREE thresholds → SKILL.md)
         │       codebase → time interval since last review (architecture survey)
         │       deps     → a lockfile changed
         │       docs     → ≥N doc files changed
         │     none fired → skip (accumulates); any fired → record reviewGate.firedSources
         ├── Classify (claude -p): none / once / multi
         └── Trigger /sharp-review skill:
               ├── pick-profile.js --sources <firedSources> → single GLOBAL weighted draw over
               │     the eligible profiles (diff | architecture | security | docs | deps); orphan
               │     mass (cold sources) folds into diff; stateless, no provider binding
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

### Host-adaptive fan-out (Claude Code + Codex)

The reviewer fan-out tool is host-specific; merge/render/write-back is shared and tested
(`lib/findings.mjs` `mergeFindings`/`renderReviewMarkdown`, invoked by `post-review.js`):
- **Claude Code** — the `Workflow` tool (`sharp-review-workflow.js`) fans out reviewers in a
  sandboxed VM, merges/renders inline (the VM can't import `lib`), returns `{ merged, markdown }`
  → `post-review.js --findings/--markdown`.
- **Codex** — no `Workflow` tool/VM. The skill fans out reviewers directly (`spawn_agent` /
  takeover `call_model`), collects raw per-reviewer `{ findings }`, and calls
  `post-review.js --raw` → the **same** shared merge/render. Host branches: `skills/sharp-review/SKILL.md` Step 3a/3b.

The Workflow VM's inline merge is a deliberate duplicate of `mergeFindings` (the VM is sandboxed
with no imports); both are covered by tests (`merge-render.test.mjs`, `post-review-raw.test.mjs`).

### Wave Gate

Reviews are gated by change accumulation, not per-session triggers. This prevents the "just reviewed, next stop triggers again" problem. Thresholds and config → `skills/sharp-review/reference/profiles-and-modes.md`.

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
│   ├── lib.mjs                   Barrel: re-exports lib/* + shared frontmatter helpers (stable `./lib.mjs`/`../scripts/lib.mjs` import path)
│   ├── lib/                      Concern modules:
│   │   ├── findings.mjs          Category inference, same-day follow-up renumber, host-agnostic mergeFindings/renderReviewMarkdown
│   │   ├── profiles.mjs          Profile registry (PROFILES) + weighted selection (resolveWeights/globalWeightsForSources/pickProfileKey)
│   │   └── manifest.mjs          Diff-manifest: isLockfile/isDoc/classifyLowValue, git -z parsing, buildManifest, renderManifestText
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
- Keep concern modules (`findings`/`profiles`/`manifest`) as the single source of truth for their logic; `lib.mjs` is only a re-export barrel. Add new shared logic to the matching module (or a new sibling), then export it through the barrel.
