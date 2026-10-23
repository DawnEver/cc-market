# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code and Codex. The review METHOD — profiles, prompt templates, finding schema, reviewer-status rules, merge/id spec — is versioned data in `method/`; the scripts are a thin Node executor of it, tested against `method/conformance/` (the same fixtures ai-lab's headless executor follows); the merge itself is ai-lab's (`python -m ai_lab.review merge`), called by `post-review.js` — this plugin keeps none. Findings are stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

Full flow: Stop hook → classify → main loop dispatches **one worker subagent** → worker runs
`/sharp-review` Steps 0-4 → memory entry → worker returns only `Sharp review: <summary>`.
Diagram and per-step detail → **`skills/sharp-review/SKILL.md`** (see Execution-mode preamble).

### Subagent execution (context isolation)

The standard trigger runs the **entire** review inside a dispatched `sharp-review:sharp-review`
worker subagent, so none of the diff/reviewer/merge noise touches the main session — only the
one-line summary returns. The dedicated agent (`agents/sharp-review.md`) has a focused
system prompt that runs `SKILL.md` (the one procedure), avoiding the `general-purpose` agent's broad
toolset and instructions. Sharp review is context-independent (operates on git state), so a
fresh subagent suffices; rem, by contrast, needs session context and is offloaded via `fork`.

### Fan-out (worker subagent / Codex)

`plan.js` decides profiles, providers and the exact prompt of every reviewer from `method/`;
the worker (Claude) or Codex worker only calls each planned reviewer via the fabric `call` MCP
tool (listed in the worker's `tools:` allowlist) and records the raw results, which
`post-review.js` merges by the method's rules. Procedure → **`skills/sharp-review/SKILL.md`**
Step 2 → **`reference/direct-fanout.md`**. Method/executor split → `docs/architecture.md`.

### Wave Gate

Reviews gated by change accumulation, not per-session. Thresholds, delta-comparison mechanics
(`lastReviewRef`/`lastReviewDiff`/ref-vanished fallback), and config keys →
**`skills/sharp-review/reference/profiles-and-modes.md`**.

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module and its responsibility) →
  `docs/architecture.md` § File Structure.
- **Method vs executor** (what is data, what could not be, how executors stay in step) →
  `docs/architecture.md` § Method vs executor.

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for the method-is-data, merge and finding-ID constraints.

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
- The method lives only in `method/` (see `.claude/rules/invariants.md`); `scripts/lib/*` modules each own one concern and `lib.mjs` is only a re-export barrel.
