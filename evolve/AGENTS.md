# evolve Plugin — AGENTS.md

A Claude-driven, iterative review→fix loop skill. Each round critiques the codebase (锐评),
fans out fix subagents over disjoint file sets, reviews the un-fixed and judges why, gates
hard calls to the human, keeps the test suite green, and commits — then loops. Skill-only
plugin: invoked via `/evolve`, no hook.

## Architecture

```
/evolve [--until --path --min-severity --dry-run --seed --commit]
  Setup: pre-flight git + dirty-tree check; require sharp-review/rem/todo; init state via scripts/evolve.mjs
  Per round (reference/round-protocol.md):
    0. Pre-flight (dirty-tree re-check, cc-market repo check)
    1. Critique: run sharp-review skill (host-agnostic) → read OPEN findings from backlog
       (seedFromSharpReview) → prioritize(minSeverity)
    2. Fan-out fix: groupFindings → disjoint groups → parallel agents (cross-cutting = 1 serial)
    3. Review un-fixed → classify reason
    4. Human gate (arch change / won't-fix / unpassable test); headless → defer
    5. Continue fixing
    6. TDD gate: detect test cmd, all green; per-finding verify
    7. Resolve & commit (scoped git add); checkTermination(state) → loop or stop
    7.5 Round-completion check: checkRoundComplete(state) → route open findings through the
        consumer-aware attention gate (shared/attention.mjs) — human: one coalesced prompt;
        ai: policy-resolve + defer, never block
```

### Host adaptivity (Claude Code + Codex)

evolve runs from the main loop on both hosts. **Exactly one touch point is host-aware:** the
step-2 fan-out fix (`Agent` per group on Claude vs. `spawn_agent` per group on Codex) — spawning
fix subagents is evolve's own orchestration primitive, so this host-awareness is irreducible.
Step-1 critique is **not** host-aware here: evolve just runs the `sharp-review` skill and reads
OPEN findings from its backlog (`seedFromSharpReview`); the Workflow-vs-raw-fan-out fork lives
entirely inside sharp-review. Helpers, gates, TDD, commits are host-agnostic. Detail →
`reference/round-protocol.md` § Host adaptivity. (On Codex, set `taskActiveUntil` at round
start — no `background_tasks` field — so the Stop hook doesn't fire mid-round.)

## File Structure

```
evolve/
├── .claude-plugin/plugin.json       Plugin manifest
├── .claude/rules/invariants.md      Dev-only constraints
├── skills/evolve/
│   ├── SKILL.md                     /evolve entry: usage, setup, per-round overview, cleanup
│   └── reference/
│       ├── round-protocol.md        Full ordered per-round protocol + state shape
│       └── termination.md           clean/resolved/ask + safety caps
├── scripts/evolve.mjs               State/grouping/termination helper (importable + CLI)
├── tests/evolve.test.mjs            node:test (13 tests)
├── CLAUDE.md / AGENTS.md / README.md
```

## Helper — `scripts/evolve.mjs`

Dependency-free Node ESM (importable + CLI). Centralizes the error-prone mechanics so the
loop never hand-edits JSON: `loadState`/`saveState` (atomic, rem state file, Windows-retry),
`initState`, `recordRound`, `groupFindings` (connected components), `prioritize`,
`checkTermination`, `confirmedByQuorum` (a unit helper; quorum is done upstream by
sharp-review's merge, not called in the live flow). Pure logic functions take timestamps as
params (no internal clock) for deterministic tests.

## Testing

```shell
node --test cc-market/evolve/tests/*.test.mjs
```

## Standard

- After changes, update README.md and this file if architecture shifts.
- Always add tests for new logic in `scripts/evolve.mjs`.
- Runtime context: the skill sees only its own `SKILL.md` + files it `Read`s — never this
  AGENTS.md or `.claude/rules/`. Keep runtime facts in `SKILL.md`/`reference/*.md`.
