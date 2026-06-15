---
name: evolve
description: Iterative TDD review→fix loop — each round critiques the codebase, fans out agents to fix findings, reviews the un-fixed and judges why, escalates hard calls to the human, runs the test suite before each commit (escalating on failure), and commits. Use when the user wants to drive a codebase to a clean state over multiple automated review/fix rounds.
---

# evolve — iterative review→fix loop

Drive a codebase toward a clean state over repeated rounds. This loop is **Claude-driven**
(run from the main loop, not a background `Workflow`) because human gates (`AskUserQuestion`)
and interactive `git commit` cannot happen inside a background workflow.

Self-contained and portable: it runs in any git project. When the `sharp-review` plugin /
`todo` CLI / rem `.rem-state.json` are present it integrates with them; otherwise it falls
back to built-in equivalents. See `README.md` for the overview.

## Usage

```
/evolve [--until=clean|resolved|ask] [--path=<dir>] [--min-severity=LOW|MEDIUM|HIGH] [--dry-run] [--seed] [--commit=round|group]
```

- `--until=ask` (**default**) — after each round, ask the user whether to start the next round.
- `--until=clean` — auto-loop until ≥2 consecutive rounds produce no new OPEN findings.
- `--until=resolved` — auto-loop until all OPEN findings are resolved (fixed or accepted won't-fix).
- `--path=<dir>` — scope the critique to a subtree instead of the whole repo.
- `--min-severity=LOW|MEDIUM|HIGH` — drop findings below this severity.
- `--dry-run` — produce findings + fix plan + grouping and report them, but make NO edits or commits (trust-building preview).
- `--seed` — pull existing OPEN findings from a `sharp-review` backlog to seed round 0.
- `--commit=round|group` — commit once per round (default) or once per finding group.

## Setup (run once, before the first round)

1. **Pre-flight (required).** Verify `git rev-parse --git-dir` succeeds (abort if not a git
   repo). Run `git status --short`: if the working tree has **unrelated** uncommitted changes,
   ask the user to commit/stash first, or to confirm proceeding — evolve commits with explicit
   per-file `git add` scope, but a dirty tree still risks confusion. Note the current branch.
2. Parse flags (see Usage). On Windows under OneDrive, run
   `git config windows.appendAtomically false` once so `git commit` doesn't fail with
   "cannot update the ref".
3. **Interruption guard (only if rem is present).** If `.claude/.rem-state.json` exists, set
   `hook.taskActiveUntil = now + 30*60*1000` so the rem Stop hook does not interrupt the loop
   mid-round. If the file is absent, skip — no guard is needed.
4. **Initialize loop state via the helper** — run
   `node "$env:CLAUDE_PLUGIN_ROOT/scripts/evolve.mjs" init [flags]` (or import `initState` from
   `$env:CLAUDE_PLUGIN_ROOT/scripts/evolve.mjs`) to create or load the state. Do **not**
   hand-write the JSON. The helper centralizes state load/save (atomic,
   rem-or-memory, Windows-retry), finding grouping, prioritization, and termination checks, so
   the loop never hand-edits JSON.

### Autonomous use

When running headless (scheduled/autonomous ticks with no human to answer `AskUserQuestion`):
the human gate cannot block — default policy is to **DEFER** any gated item (leave it OPEN, log
it) and never hang on `AskUserQuestion`. Surface all deferred/gated items in the final summary.

## Per round (overview)

1. **Critique (锐评)** — architecture + diff review → an OPEN findings list.
2. **Fan-out fix** — parallel subagents over disjoint file sets (≤ `maxAgents`).
3. **Review the un-fixed** — classify each remaining finding's reason.
4. **Human gate** — `AskUserQuestion` for architectural changes, won't-fix calls, or
   unpassable tests.
5. **Continue fixing** per the human's answers.
6. **TDD gate** — run the test suite; all green before committing.
7. **Resolve & commit** — mark findings, commit (explicit `git add` scope), apply termination.

**`--dry-run` is a first-class mode:** run step 1 (critique) and produce the fix plan +
grouping (steps 2–3 planning only), report it, and **STOP** — no edits, no test gate, no
commit.

**Context budget:** to avoid unbounded context growth over many rounds, findings are persisted
to state/file (via the helper) rather than kept only in conversation, and each round's heavy
critique/fix work is delegated to subagents — the main loop holds only the structured results
and short summaries.

**Before executing a round, read `reference/round-protocol.md`** (the full ordered protocol,
state shape, and failure handling). Stop conditions and the safety caps are in
`reference/termination.md`.

## Cleanup (on exit — normal stop or abort)

- If you set it in Setup, remove `hook.taskActiveUntil` from `.claude/.rem-state.json`
  (load JSON, `delete state.hook.taskActiveUntil`, write back atomically via `.rem-state.tmp`
  + rename). If the loop crashes, the rem Stop hook auto-expires it after 30 min, so a
  lingering value is harmless. Also delete any stale `.claude/.rem-state.tmp` left by a failed
  atomic write.
- Write a short round-log memory entry via `writeRoundLog(projectRoot, {...})` — it writes a
  rem-frontmatter entry under `.claude/memory/YYYY/MM/DD/`, so rem's session indexer picks it
  up automatically (no need to rebuild the index here).
- Report a one-line summary in chat (rounds, total fixed, won't-fix, deferred items).
