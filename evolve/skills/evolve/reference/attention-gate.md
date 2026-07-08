# evolve — the attention gate (step 7.5 detail)

Read this when a round is **not complete** (step 7.5 of `round-protocol.md` found still-`open`
findings) and you need to route them without either swallowing them or flooding the human.

The gate lives in `shared/attention.mjs`; evolve calls it via
`routeRoundCompletion(state, { consumer })`. Its whole job is to protect the scarce resource on
the *receiving* end — so it routes on **who is consuming the result**.

## Detect the consumer first

- `consumer: 'human'` — a person can answer `AskUserQuestion` (interactive run). Default when
  unsure and a human is present.
- `consumer: 'ai'` — headless/autonomous, or `/evolve` was invoked *by another agent* (a parent
  orchestrator, a scheduled tick) that consumes the result programmatically. Pass
  `{ consumer: 'ai' }` in those cases.

## Human consumer

The gate auto-`defer`s reversible, non-HIGH findings (`applied`) so it does **not** spend a
decision prompt on them, and returns a single coalesced `prompt` (`AskUserQuestion`, ≤4 questions,
highest-stakes first; `overflow` carries the rest to next round) covering only the decisions that
truly need you — irreversible/arch or HIGH stakes. Ask it, then apply the answers
(fix / record wont-fix / defer).

**The auto-deferred set is suppressed as a *decision*, not as *information*:** emit one
non-blocking line (`N low-stakes findings deferred → still OPEN in backlog, see \`todo\`: SR-…`),
never an `AskUserQuestion`. They are not dropped.

## AI consumer

The gate **never prompts** (no human attention to protect). It returns `applied` (defaults
resolved by policy) and `deferred` (irreversible/ambiguous, no safe default — left OPEN and
logged, never blocked). Apply `applied`, record `deferred` in the round summary. An AI consumer
that *wants* a second opinion on a deferred arch call may hand it to a stronger model via
`fabric` (call), but must not block the loop on it.

## Both consumers

Record the gate's `applied`/`deferred`/answers back into `evolveState.findings`, so the next
round sees accurate status and the round summary reflects what was decided vs deferred.

## `defer` ≠ drop (the guarantee)

A deferred finding — LOW included — is *not* resolved and is *not* abandoned. Three mechanisms
ensure it still gets solved:

1. **It stays in the backlog.** It remains `status: open` in `evolveState.findings` and in the
   `todo`/`sharp-review.md` source of truth — visible and resolvable at any time, including after
   the loop exits.
2. **Fan-out re-attempts it every round.** Step 2 fixes findings in HIGH→MEDIUM→LOW order across
   *all* open findings regardless of stakes. A LOW item is OPEN at step 7.5 only because this
   round's fix attempt didn't close it — next round it gets another automatic attempt. The gate
   governs *whether to interrupt you*, never *whether to fix it*.
3. **It escalates if it gets stuck.** `recordRound` increments `unfixedRounds` on every still-open
   finding; at `unfixedRounds = 3` the stuck-finding cap (`reference/termination.md`) stops the
   auto-loop and surfaces that exact finding to you — so a LOW item that proves un-fixable cannot
   silently defer forever.

## Convergence caveat (`--until=clean`)

clean-convergence is severity-based, so the loop can exit with LOW findings still open. That is
intended (LOW nits must not block convergence) — but it means the **exit summary MUST report the
count of still-open deferred findings and point to `todo`**, so they leave the loop *visible*, not
silently swallowed. If you want LOW items to also block the loop, run `--until=resolved` (stops
only when every finding is fixed or accepted wont-fix) instead of `clean`.
