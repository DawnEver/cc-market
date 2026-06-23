# evolve — round protocol

The full ordered protocol for one round. Execute the steps in order. Never abort the whole
round because a single subagent failed — filter out null results and continue.

**Host-adaptivity context** → AGENTS.md § Host adaptivity for the one touch point (step 2
fan-out is host-aware — `Agent` vs `spawn_agent`). All other steps are host-agnostic. On
Codex, set the task guard at round start so the Stop hook doesn't fire mid-round.

## Helper module — `scripts/evolve.mjs`

Do **not** hand-edit state JSON or hand-compute grouping/termination. Delegate every
state/grouper/gate operation to the helper (importable + CLI:
`node "$env:CLAUDE_PLUGIN_ROOT/scripts/evolve.mjs" <cmd> [args]`). Key functions:
`loadState`/`saveState` (atomic, preserves rem's other keys), `initState`, `recordRound`,
`prioritize`, `groupFindings`, `seedFromSharpReview`, `checkTermination`, `checkRoundComplete`,
`routeRoundCompletion`, `writeRoundLog`, `setTaskGuard`/`clearTaskGuard`. State I/O delegates
to `shared/state.mjs`; never hand-write `.claude/.rem-state.json`.

## 0. Pre-flight (every round)

- Confirm still inside a git repo; note the current branch.
- Re-run `git status --short` and diff against the previous round's snapshot: pause on new
  unrelated mid-loop changes, then take this round's snapshot for scoped `git add` at commit.
- If any touched file lives under `cc-market/`, verify `git -C cc-market rev-parse --git-dir`
  succeeds; abort if `cc-market/` exists but isn't its own repo.

## 1. Architecture critique (锐评)

Goal: produce a quorum-confirmed, severity-sorted **OPEN findings list** for this round.

**Critique target:**
- `--path <glob>` scopes the critique; default is the whole repo.
- Clean working tree (no diff): review the codebase in scope (or seeded backlog).
- Working diff present: review that diff plus directly-touched modules.
- `--seed`: pull existing OPEN findings from a `sharp-review.md` backlog via
  `seedFromSharpReview(projectRoot, date)`.

Run the critique by invoking the `sharp-review` skill — **host-agnostic**: sharp-review writes
findings to the `sharp-review.md` backlog; evolve reads **OPEN** entries via
`seedFromSharpReview(projectRoot, date)`. evolve does **not** consume a tool return value,
re-run `confirmedByQuorum`, or know how sharp-review fans out internally — routing through
the backlog keeps the boundary clean.

**Finding identity:** findings carry stable SR-IDs. The same finding keeps its id across
rounds. New findings start `status: OPEN`, `unfixedRounds: 0`.

**Priority:** pass findings through `prioritize(findings, minSeverity)` to apply
`--min-severity` and severity-sort. LOW/INFO findings do not block clean convergence.

**Arch detection:** set `arch: true` on any finding whose summary/suggestion implies a
cross-module refactor, public interface/signature change, or data-model/schema change
(signals: *interface, export, schema, data model, migration, breaking*). `arch: true`
feeds the human gate (step 4).

## 2. Fan-out fix

Fix findings in HIGH→MEDIUM→LOW order (`prioritize` output), grouped into **disjoint file
sets** via `groupFindings(findings)`, one `Agent` per group.

- **Grouping:** `groupFindings` returns disjoint connected-component groups. Keep any finding
  with an uncertain file-closure in its own group; tell its agent to stay within declared files.
- **Cross-cutting:** a finding spanning many files collapses to one large group — run it
  **serially**, not in parallel. Disjoint fan-out is for independent local fixes.
- **Cap:** at most `maxAgents` (default 8) groups concurrently; queue excess.
- **Overrun rule:** if an agent edits a file outside its declared set that overlaps another
  group, revert (`git checkout -- <file>`) and re-run those findings serially.
- Each agent: implement fixes, report `{ id, fixed: bool, reason, filesModified: [...] }`.

## 3. Review the un-fixed

Collect every finding **not** marked `fixed`; increment `unfixedRounds`. Classify reason:
- `false-positive` — finding is wrong.
- `intentional` — current behavior is deliberate.
- `out-of-scope` — real but belongs to other work.
- `needs-architecture-decision` — design call beyond this round.

## 4. Human-in-the-loop gate

Gate (prefer `shared/attention.mjs` via `routeRoundCompletion`; hand-roll `AskUserQuestion`
only for one-off questions the gate can't express) if the round produced any of:
- (a) an **architectural change** (`arch: true` or a fix changing an interface/data model);
- (b) a **won't-fix** finding — confirm before accepting;
- (c) a **test failure** that couldn't be auto-fixed (step 6).

Apply answers: fix / accept won't-fix / re-approach.

## 5. Continue fixing

Loop back through fan-out for any item the human said to fix or re-approach, until no
actionable item remains.

## 6. TDD gate

Detect the test command: `package.json` scripts.test → `npm test`; Node test files →
`node --test <dir>/*.test.mjs`; Python → `pytest`; other → `cargo test`, `go test ./...`, etc.
None detected → ask the user; if no tests exist, skip **with an explicit warning** — never
silently skip.

If tests fail: auto-fix attempt (back to step 5). If still failing, escalate via human gate
(step 4c) — do **not** commit red.

**Per-finding verification:** after a green suite, re-check each claimed-fixed finding is
truly resolved. Any not actually closed goes back to `OPEN` (its `unfixedRounds` keeps
incrementing) — do not mark it fixed in step 7.

## 7. Resolve & commit

- Mark each finding `fixed` or `wont-fix` (with reason) via `todo mark <ID> <status>`. Mirror
  status into `evolveState.findings`.
- **Stage only evolve's changes:** `git add <file> ...` listing exactly the files the round's
  agents modified (diff against step-0 snapshot). Never `git add -A`.
- **Commit granularity (`--commit=round|group`):** default `round` — one commit per round.
  `group` — one commit per fix-group, independently reviewable/revertable.
- Commit message using Bash HEREDOC:
  ```bash
  git commit -m "$(cat <<'EOF'
  fix: evolve round N — <summary>
  EOF
  )"
  ```
- **Windows + OneDrive:** if `git commit` fails with "cannot update the ref", run
  `git config windows.appendAtomically false` then retry. **cc-market:** changed files under
  `cc-market/` → commit with `git -C cc-market`.
- **Protected-branch guard:** re-check every round. Treat `main`/`master`/`release/*` as
  protected. Auto modes normally commit each round; on a protected branch, **skip auto-commit
  and prompt** — never force-push.
- Bump state via `recordRound(state, ..., now=Date.now())`, which calls `saveState`. If the
  atomic rename flakes, state stays in memory — never block the loop on a state-write failure.
- Apply termination: call `checkTermination(state)` → `{ stop, reason }`. Definitions in
  `reference/termination.md`.

## 7.5 Round-completion check (every round, after commit)

A round is **not done** until every finding it touched reached a terminal state. Still-open
findings must be surfaced, not carried silently.

- Call `checkRoundComplete(state)` → `{ complete, openFindings }`. If complete, continue to
  termination.
- Otherwise route through the **attention gate**: `routeRoundCompletion(state, { consumer })`
  (`shared/attention.mjs`). Human → one coalesced `AskUserQuestion`; AI → policy-resolve +
  defer. **`defer` ≠ drop** — deferred findings stay OPEN, get re-attempted every round, and
  escalate at the stuck-finding cap. Full routing rules → `reference/attention-gate.md`.

## State shape

The `evolveState` schema in `.claude/.rem-state.json` is for debugging only — delegate all
I/O to `scripts/evolve.mjs`. Full schema → `reference/state-schema.md`.

## Failure handling

- Dead/failed subagent → `null` result; filter and continue.
- Never commit with failing tests.
- State persisted atomically by `saveState`/`recordRound`; if loop crashes, the task guard
  auto-expires after 30 min (rem Stop hook self-heals).
