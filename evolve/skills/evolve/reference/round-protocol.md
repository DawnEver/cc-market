# evolve — round protocol

The full ordered protocol for one round. Execute the steps in order. Never abort the whole
round because a single subagent failed — filter out null results and continue.

## Helper module — `scripts/evolve.mjs`

Do **not** hand-edit state JSON or hand-compute grouping/termination. Delegate the mechanics
to the helper (importable + CLI:
`node "$env:CLAUDE_PLUGIN_ROOT/scripts/evolve.mjs" <init|load|group|terminate|prioritize>`):

- `loadState` / `saveState` — atomic, backed by rem's `.claude/.rem-state.json` (a hard
  dependency, verified in Setup), with Windows retry. Use instead of manual read/rename.
- `initState` — create a fresh `evolveState` (step Setup).
- `recordRound` — bump `round`/`lastRoundAt` and persist (step 7).
- `prioritize(findings, minSeverity)` — filter by `--min-severity` and sort HIGH→MEDIUM→LOW
  (steps 1/2). (Quorum/dedup is done upstream by sharp-review's merge, not re-run here.)
- `groupFindings(findings)` — disjoint connected-component fix-groups (step 2).
- `seedFromSharpReview(projectRoot, date)` — `--seed`: read OPEN findings from an existing
  `sharp-review.md` backlog (reuses `shared/lib.mjs parseFindingsFromMarkdown`), step 1.
- `writeRoundLog(projectRoot, {...})` — cleanup: write the round-log as a rem-frontmatter
  memory entry so rem's indexer picks it up (no need to call rem's `rebuildIndex`).

State I/O and `dateToPath` come from the bundled `shared/` (`shared/state.mjs`,
`shared/lib.mjs`) — the same modules rem/sharp-review use — not re-implemented here. `saveState`
always persists to rem's state file (creating it if absent); there is no in-memory fallback.
- `checkTermination(state)` → `{ stop, reason }` — the termination decision (step 7).
- `checkRoundComplete(state)` → `{ complete, openFindings }` and
  `routeRoundCompletion(state, {consumer})` — the round-completion check + attention-gate routing
  (step 7.5). The gate itself is `shared/attention.mjs` (`route`/`classify`/`compress`).

Keep the conceptual explanation in each step; let the script do the arithmetic.

## 0. Pre-flight (every round)

- Confirm still inside a git repo and note the current branch (set in Setup).
- Re-run `git status --short` and **diff against the previous round's snapshot**: if the user
  introduced new *unrelated* changes mid-loop, pause and confirm before proceeding (their edits
  must not be swept into evolve's commit). Then take this round's snapshot of already-modified
  files so the commit step can scope `git add` to only what evolve changes this round.
- If any file evolve may touch lives under `cc-market/`, verify
  `git -C cc-market rev-parse --git-dir` succeeds; if `cc-market/` exists but is not its own
  git repo, abort with a clear message rather than failing silently at commit.

## 1. Architecture critique (锐评)

Goal: produce a quorum-confirmed, severity-sorted **OPEN findings list** for this round.

**Critique target (be explicit about what is reviewed):**

- `--path <glob>` scopes the critique to those files/modules; default is the whole repo scope.
- **Clean working tree (no diff):** review the codebase/modules in scope (or the seeded
  backlog) — never an empty diff. Reviewing nothing yields nothing.
- **Working diff present:** review that diff (plus directly-touched modules).
- `--seed`: if set and a sharp-review findings store exists
  (`.claude/memory/.../sharp-review.md`), seed this round's findings from its existing **OPEN**
  entries — in addition to (or, on a clean tree, instead of) a fresh critique. Use the helper
  `seedFromSharpReview(projectRoot, date)` (it reuses `shared/lib.mjs parseFindingsFromMarkdown`
  + SR-ID parsing) rather than re-parsing the markdown by hand.

Run the critique via `Workflow({ name: 'sharp-review' })` (the `sharp-review` plugin is a hard
dependency, verified in Setup) and consume the returned `merged` findings. The plugin handles
diff sizing (`diff-manifest.js` → review/agent/empty mode), runs ≥2 reviewers, and assigns
stable `SR-YYYYMMDD-NNN` IDs. Its merge step already performs the ≥2-reviewer quorum/dedup, so
evolve does **not** re-run `confirmedByQuorum` on the merged output.

**Finding identity (across rounds):** findings come from sharp-review, so use its SR-IDs — the
same finding keeps its id if it recurs in a later round. New findings start at `status: OPEN`,
`unfixedRounds: 0`.

**Priority (before acting):** pass the merged findings through `prioritize(findings,
minSeverity)` to apply the `--min-severity` filter and severity-sort. (Note: `clean`
convergence is severity-based — LOW/INFO findings do not block convergence; see
`reference/termination.md`.)

Record the confirmed findings into `evolveState.findings`. **Architecture pass:** set `arch: true` on any
finding whose `summary`/`suggestion` implies a cross-module refactor, a public
interface/signature change, or a data-model/schema change — detect via those signals (keywords
like *interface, export, schema, data model, migration, breaking*) when a reviewer did not
already set the `arch` flag. `arch: true` feeds the human gate (step 4).

## 2. Fan-out fix

Fix findings in **HIGH→MEDIUM→LOW** order (use `prioritize(findings, minSeverity)` from step 1
as the ordering), grouped into **disjoint file sets**, then spawn one `Agent` per group.

- **Grouping (delegated):** call `groupFindings(findings)` — it estimates each finding's file
  closure and returns disjoint connected-component groups (merging any two findings whose
  estimated file-sets intersect), so no two agents edit the same file. Treat each estimate as a
  *lower bound* (see the overrun rule). Keep any finding with an uncertain closure in its own
  group and tell its agent to **stay within its declared files**.
- **Cross-cutting changes:** if a finding's fix spans many files (e.g. an API rename used
  across the repo), `groupFindings` will collapse it into one large group — hand that group to
  a **single coordinated agent run serially**, not forced into parallel. The disjoint-grouping
  fan-out is for *independent local* fixes; one sprawling change is one serial agent.
- **Cap:** spawn at most `maxAgents` (default 8) groups concurrently in one message; queue any
  excess to the next batch within the same round.
- **Overrun rule:** instruct each agent to edit only its group's files. If an agent reports
  modifying a file outside its declared set that overlaps another group, revert that file
  (`git checkout -- <file>`, or `git restore <file>`) and re-run those findings serially via a
  single agent (outside the parallel fan-out) in the next batch — never let two edits race on
  one file.
- Use `isolation: "worktree"` only if you cannot make file-sets disjoint; otherwise plain
  agents on disjoint sets (cheaper).
- Each agent: implement the fixes for its findings, then report `{ id, fixed: bool, reason }`
  for every finding it owned, plus the exact list of files it modified.

## 3. Review the un-fixed

Collect every finding **not** marked `fixed`; increment its `unfixedRounds`. For each,
classify the reason:

- `false-positive` — the finding is wrong; nothing to change.
- `intentional` — current behavior is deliberate.
- `out-of-scope` — real but belongs to other work.
- `needs-architecture-decision` — requires a design call beyond this round.

## 4. Human-in-the-loop gate

Call `AskUserQuestion` (summarizing the items) if the round produced **any** of:

- (a) an **architectural change** (any `arch: true` finding being acted on, or a fix that
  changed an interface/data model);
- (b) a **won't-fix** finding (`false-positive` / `intentional` / `out-of-scope`) — confirm
  before recording it as accepted;
- (c) a **test failure** that could not be auto-fixed (see step 6).

Apply the answers: fix it / accept won't-fix-with-reason / change the approach.

Prefer routing these through the **attention gate** (`shared/attention.mjs`, step 7.5) rather
than a hand-written `AskUserQuestion`: it compresses each item to *what you must know / decide /
the consequence of not deciding*, coalesces multiple gated items into one prompt for a human,
and — for an AI consumer — resolves by policy without prompting at all. Hand-roll
`AskUserQuestion` only for genuinely one-off questions the gate's item shape can't express.

## 5. Continue fixing

Loop back through fan-out fixes for any item the human said to fix or re-approach, until no
actionable item remains.

## 6. TDD gate

Detect the project's test command in this order; **all tests must pass before committing.**

1. `package.json` `scripts.test` → `npm test`.
2. Node test files → `node --test <dir>/*.test.mjs` (e.g. a plugin's `tests/`).
3. Python → `pytest` if `pyproject.toml` / `setup.py` / `tests/` present.
4. Other ecosystems → the conventional command (`cargo test`, `go test ./...`, etc.).
5. **None detected** → ask the user for the test command via `AskUserQuestion`. If the user
   says there are no tests, skip the TDD gate **with an explicit warning in the summary** —
   never silently skip. After a warned skip the round still proceeds to commit (step 7).

If tests fail: attempt an auto-fix (back to step 5). If still failing after a reasonable
attempt, escalate via the human gate (step 4c) — do **not** commit red.

**Per-finding verification:** a green global suite is necessary but not sufficient. For each
finding an agent claimed `fixed`, run a quick *targeted* re-check that the specific issue is
actually resolved (re-read the changed lines / run the narrow test or repro that exercises it).
Any claimed-fixed finding that does not truly close goes back to `status: OPEN` (its
`unfixedRounds` keeps incrementing) and re-enters fan-out (step 5) — do not mark it fixed in
step 7.

## 7. Resolve & commit

- Mark each finding `fixed` or `wont-fix` (with reason). The `todo` CLI and sharp-review
  findings store are hard dependencies, so ids are always `SR-*`: use `todo mark <ID> fixed`,
  treating `todo`/`sharp-review.md` as the source of truth, and mirror status into
  `evolveState.findings`.
- **Stage only evolve's own changes:** `git add <file> ...` listing exactly the files the
  round's agents reported modifying (diff against the step-0 snapshot). Never `git add -A` —
  the user may have unrelated work in the tree.
- **Commit granularity (`--commit=round|group`):** default `round` — one commit per round
  staging all of the round's files. With `--commit=group`, stage and commit **per fix-group**
  (from step 2's `groupFindings`) so each group is an independently reviewable/revertable
  commit; iterate the staging + commit below once per group.
- Commit with a conventional message using the **Bash HEREDOC** form (avoids PowerShell
  here-string `@` leakage — this convention is self-contained, no external rule file needed):
  ```bash
  git commit -m "$(cat <<'EOF'
  fix: evolve round N — <summary>
  EOF
  )"
  ```
  **Windows + OneDrive:** `git commit` can fail with `cannot update the ref ... Invalid
  argument` when the repo lives under OneDrive. Fix once with
  `git config windows.appendAtomically false`, then retry the commit.
  **cc-market integration:** if the changed files live under `cc-market/` (a separate,
  gitignored repo), commit there instead: `git -C cc-market add <files>` then
  `git -C cc-market commit -m ...`. Files under `cc-market/` and files in the host repo are
  two separate commits.
- **Protected-branch guard (re-checked every round, critical for auto modes):** before
  committing, confirm the current branch is not protected/shared — treat `main`/`master` and
  `release/*` as protected by default, honor any host-known branch protections, and when unsure
  ask the user. Auto modes (`clean`/`resolved`) normally commit each round without prompting;
  a protected branch is the one exception — there, **skip the auto-commit and prompt the user**
  (do not commit until they confirm or switch branch). Never force-push.
- Bump round state and persist via the helper: `recordRound` (which calls `saveState`). The
  helper writes rem's `.claude/.rem-state.json` atomically (creating it if absent) and handles
  the Windows/OneDrive rename retry internally — do not hand-roll the tmp-write/rename. If the
  atomic rename ultimately flakes (`persisted:false`), state stays in memory for the session;
  note that in the summary and never block the loop on a state-write failure.
- Apply the termination policy: call `checkTermination(state)` → `{ stop, reason }` and act on
  it. Definitions live in `reference/termination.md` (not duplicated here).

## 7.5 Round-completion check (every round, after commit)

A round is **not done** until every finding it touched reached a terminal state
(`fixed` / accepted `wont-fix`). Findings left `open` are otherwise carried silently — their
`unfixedRounds` just climbs until the stuck-finding cap at round 3. Make the carry **explicit**
and route it through the attention gate instead of swallowing it.

- Call `checkRoundComplete(state)` → `{ complete, openFindings }`. If `complete`, the round is
  clean — continue to termination.
- Otherwise route the un-terminal findings through the **attention gate**
  (`shared/attention.mjs`, via `routeRoundCompletion(state, { consumer })`). The gate is
  **consumer-aware** — its whole job is to protect the scarce resource on the receiving end:
  - **Detect the consumer first.** `consumer: 'human'` when a person can answer
    `AskUserQuestion` (interactive run); `consumer: 'ai'` when headless/autonomous, or when
    `/evolve` was invoked *by another agent* (e.g. a parent orchestrator, a scheduled tick) that
    consumes the result programmatically. Pass `{ consumer: 'ai' }` in those cases. When unsure
    and a human is present, default to `'human'`.
  - **Human consumer** → the gate auto-`defer`s reversible, non-HIGH findings (`applied`) so it
    does **not** spend a decision prompt on them, and returns a single coalesced `prompt`
    (`AskUserQuestion` payload, ≤4 questions, highest-stakes first; `overflow` carries the rest
    to next round) covering only the decisions that truly need you — irreversible/arch or HIGH
    stakes. Ask it, then apply the answers (fix / record wont-fix / defer). **The auto-deferred
    set is suppressed as a *decision*, not as *information*:** emit one non-blocking line
    (`N low-stakes findings deferred → still OPEN in backlog, see \`todo\`: SR-…`), never an
    `AskUserQuestion`. They are not dropped.
  - **AI consumer** → the gate **never prompts** (there is no human attention to protect). It
    returns `applied` (defaults resolved by policy) and `deferred` (irreversible/ambiguous, no
    safe default — left OPEN and logged, never blocked). Apply `applied`, record `deferred` in
    the round summary. An AI consumer that *wants* a second opinion on a deferred arch call may
    hand it to a stronger model via `takeover`, but must not block the loop on it.

  In both cases: record the gate's `applied`/`deferred`/answers back into
  `evolveState.findings`, so the next round sees accurate status and the round summary reflects
  what was decided vs deferred.

**`defer` ≠ drop (the guarantee).** A deferred finding — LOW included — is *not* resolved and is
*not* abandoned. Three mechanisms ensure it still gets solved:

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

**Convergence caveat (`--until=clean`):** clean-convergence is severity-based, so the loop can
exit with LOW findings still open. That is intended (LOW nits must not block convergence) — but it
means the **exit summary MUST report the count of still-open deferred findings and point to
`todo`**, so they leave the loop *visible*, not silently swallowed. If you want LOW items to also
block the loop, run `--until=resolved` (stops only when every finding is fixed or accepted
wont-fix) instead of `clean`.

## State shape (`.claude/.rem-state.json`)

```jsonc
{
  "hook": { "taskActiveUntil": 0 },      // set during loop (rem only), deleted on exit
  "evolveState": {
    "round": 0,
    "until": "ask",                       // ask | clean | resolved
    "maxRounds": 10,                       // hard backstop (all modes)
    "maxAgents": 8,                        // max concurrent fix agents per batch
    "lastRoundAt": null,
    "emptyRounds": 0,                      // consecutive rounds with no new OPEN findings
                                           //   (incremented by the termination policy)
    "findings": [ /* { id, file, summary, status, reason?, unfixedRounds, arch? }
                     id is an SR-YYYYMMDD-NNN (sharp-review) or a "file|summary" string (fallback) */ ]
  }
}
```

## Failure handling

- A dead/failed subagent → its result is `null`; filter and continue the round.
- Never commit with failing tests.
- State is persisted atomically by `saveState`/`recordRound`; if the loop crashes,
  `taskActiveUntil` auto-expires after 30 min (rem Stop hook self-heals).
