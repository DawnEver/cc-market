# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code and Codex. The review METHOD — profiles, prompt templates, finding schema, reviewer-status rules, merge/id spec — is ai-lab's versioned data, and so are its planner (`python -m ai_lab.review.plan`, called by `plan.js`) and its merge (`python -m ai_lab.review.merge`, called by `post-review.js`); this plugin collects the manifest, fans reviewers out and writes the report sink, and keeps no method data or logic. Findings are written as one regenerable report `output/logs/YY/MM/DD/sharp-review/sharp-review.md` (path: ai-lab's `report_path`, carried in the plan as `report`) — program output, never a tracked memory path; a finding a person chooses to keep becomes a forge issue.

## Architecture

Full flow: `/sharp-review` (or a workflow such as evolve) → main loop dispatches **one worker subagent** → worker runs
Steps 0-4 → report → worker returns only `Sharp review: <summary>`.
Diagram and per-step detail → **`skills/sharp-review/SKILL.md`** (see Execution-mode preamble).
The plugin ships no hooks (`tests/hook-timeouts.test.mjs` `SHIPS_NO_HOOKS`, user ruling
2026-11-17): a review runs only on demand.

### Subagent execution (context isolation)

A review runs **entirely** inside a dispatched `sharp-review:sharp-review`
worker subagent, so none of the diff/reviewer/merge noise touches the main session — only the
one-line summary returns. The dedicated agent (`agents/sharp-review.md`) has a focused
system prompt that runs `SKILL.md` (the one procedure), avoiding the `general-purpose` agent's broad
toolset and instructions. Sharp review is context-independent (operates on git state), so a
fresh subagent suffices; rem, by contrast, needs session context and is offloaded via `fork`.

### Fan-out (worker subagent / Codex)

`plan.js` collects the manifest and has ai-lab's planner decide profiles, providers and the exact prompt of every reviewer;
the worker (Claude) or Codex worker only calls each planned reviewer via the fabric `call` MCP
tool (listed in the worker's `tools:` allowlist) and records the raw results, which
`post-review.js` has ai-lab merge. Procedure → **`skills/sharp-review/SKILL.md`**
Step 2 → **`reference/direct-fanout.md`**. Method/executor split → `docs/architecture.md`.
Config keys → **`skills/sharp-review/reference/profiles-and-modes.md`**.

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module and its responsibility) →
  `docs/architecture.md` § File Structure.
- **Method vs executor** (what is data, what could not be, how executors stay in step) →
  `docs/architecture.md` § Method vs executor.

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for the method, planner, merge and finding-ID constraints.


## Task System

Sharp-review owns findings end-to-end. `post-review.js` writes `sharp-review.md` under `output/logs/` and stamps no memory. A finding worth keeping becomes a forge issue.

Full file-ownership table → `skills/sharp-review/reference/task-system.md`.

## Testing

```shell
node --test cc-market/sharp-review/tests/*.test.mjs
```

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic.
- The method and its logic live only in ai-lab (see `.claude/rules/invariants.md`); `scripts/lib/*` modules each own one concern and `lib.mjs` is only a re-export barrel.
