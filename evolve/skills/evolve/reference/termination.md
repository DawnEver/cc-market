# evolve — termination policy

Applied at the end of each round (after commit). `--until` selects the mode; default `ask`.
The safety caps below apply in **all** modes.

Termination is computed via `checkTermination(state) → {stop, reason}` from
`scripts/evolve.mjs` — not hand-evaluated. It enforces the convergence mode, the safety caps,
and the autonomous-run policy below.

## `ask` (default)

After committing, call `AskUserQuestion`:

> Round N committed (`<X fixed, Y won't-fix>`). Start the next evolution round?
> - **Continue** — run another round.
> - **Stop** — end the loop here.

Stop ends the loop and runs cleanup.

## `clean`

Auto-loop. Convergence is **severity-based**: a round counts as "empty" when it produces no
new OPEN findings of severity **HIGH or MEDIUM**. LOW/INFO findings do **not** block
convergence. Stop after **≥2 consecutive empty rounds**. Tracked via `evolveState.emptyRounds`
inside `checkTermination`:

- New OPEN HIGH/MEDIUM findings this round → `emptyRounds = 0`, continue.
- None → `emptyRounds += 1`; if `emptyRounds >= 2`, stop.

**Why severity-based (the key fix):** LLM reviewers always surface minor/clarity nits, so a
naive "no new findings at all" rule never converges — in practice it just ran every loop to
`maxRounds`. Counting only HIGH/MEDIUM lets the loop actually settle once the substantive
issues are gone.

Findings are already **quorum-filtered upstream** — sharp-review's merge only emits findings
confirmed by ≥2 reviewers, so single-reviewer noise never reaches the convergence count.

## `resolved`

Auto-loop. Stop when **all findings are resolved** — every finding in `evolveState.findings`
has `status: fixed` or an accepted `wont-fix` (with reason), **and** the latest critique
produced no new OPEN findings. Edge case: if round 1's critique finds nothing (codebase
already clean), `findings` is empty and this condition is true immediately — the loop exits
after one (no-op) round. That is intended.

## Safety caps (all modes)

- **Max rounds backstop:** if `evolveState.round` reaches `maxRounds` (default 10), stop the
  auto-loop and surface to the user via `AskUserQuestion` before continuing. This bounds
  runaway when findings churn every round (new ones appear as old ones are fixed), which the
  per-finding stop below cannot catch.
- **Stuck-finding stop:** if any single finding's `unfixedRounds` reaches 3 (it survived 3
  rounds without being fixed or accepted), stop the auto-loop and surface that finding to the
  user — it likely needs a human decision.

Both caps are enforced by `checkTermination` and convert an auto mode (`clean`/`resolved`)
into an `ask`-style prompt rather than silently looping forever.

## Autonomous / headless runs

When no human can answer the per-round `ask` prompt or a human gate (headless/autonomous
runs), the loop must **never hang on `AskUserQuestion`**:

- **Gated / won't-fix items** are deferred — left OPEN and logged, not blocked on.
- An **unanswered prompt is treated as "stop"** by default, or the loop continues per a
  preset policy — but it never blocks indefinitely.

`resolved` and the safety caps (max-rounds, stuck-finding) are unchanged in autonomous mode
and remain enforced by `checkTermination`.

## On stop

Run the SKILL.md cleanup: remove `hook.taskActiveUntil` (if set), write the round-log memory
entry via `writeRoundLog` (rem indexes it automatically), and report a one-line summary in chat
(rounds run, total fixed, won't-fix, any deferred items, and whether a safety cap triggered).
