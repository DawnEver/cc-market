# Sharp Review Plugin — AGENTS.md

Post-feature code review plugin for Claude Code. Parallel reviewers drawn dynamically from fabric `list_providers` (2 of N), whose findings are normalized to one schema, cross-checked and merged. (Anthropic-compatible providers — claude/deepseek/kimi — return schema JSON directly; codex review-mode returns prose the worker normalizes into the schema before merge — see `skills/sharp-review/reference/direct-fanout.md` § Codex prose normalization.) Findings stored as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter — the sole source of truth. No derived `tasks.md`; the `todo` CLI scans memory directly.

## Architecture

Full flow: Stop hook → classify → main loop dispatches **one worker subagent** → worker runs
`/sharp-review` Steps 1-6 → memory entry → worker returns only `Sharp review: <summary>`.
Diagram and per-step detail → **`skills/sharp-review/SKILL.md`** (see Execution-mode preamble).

### Subagent execution (context isolation)

The standard trigger runs the **entire** review inside a dispatched `sharp-review:sharp-review`
worker subagent, so none of the diff/reviewer/merge noise touches the main session — only the
one-line summary returns. The dedicated agent (`agents/sharp-review.md`) carries a focused
system prompt with the full review procedure, avoiding the `general-purpose` agent's broad
toolset and instructions. Sharp review is context-independent (operates on git state), so a
fresh subagent suffices; rem, by contrast, needs session context and is offloaded via `fork`.

### Fan-out (worker subagent / Codex)

The worker subagent (Claude) or Codex worker fans out reviewers directly via the takeover
`call` MCP tool (which the worker agent must list in its `tools:` allowlist; fallback:
`Agent`/`spawn_agent`), collects each reviewer's `{ findings }` (normalizing codex prose into
the schema — see direct-fanout.md), and feeds `post-review.js --raw` — which runs the shared
merge/render so every host produces byte-identical output. Full procedure →
**`skills/sharp-review/SKILL.md`** Step 3 → **`reference/direct-fanout.md`**.

### Wave Gate

Reviews gated by change accumulation, not per-session. Thresholds, delta-comparison mechanics
(`lastReviewRef`/`lastReviewDiff`/ref-vanished fallback), and config keys →
**`skills/sharp-review/reference/profiles-and-modes.md`**.

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module and its responsibility) →
  `docs/architecture.md` § File Structure.
- **Review Profiles & Modes** dev seam (profile-as-template, weighted selection, additive
  seam, config-vs-state split) → `docs/architecture.md` § Review Profiles & Modes.

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for diff manifest, schema, finding ID, and resolution constraints.

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
