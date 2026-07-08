---
name: evolve-convergence-and-fabric-validation
tier: short
created: 2026-07-08
---

# Evolve convergence + fabric live validation

## Evolve run (engines-into-shared refactor, branch feat/substrate-observe-proxy)

5 fix rounds + a round-6 verification review reached **0 new findings** (Codex + DeepSeek
both clean). 42 findings total (SR-20260708-001..042): 38 fixed failing-test-first, 4 INFO
accepted (020/021/039/040). Round commits squashed into `1c4c872`.

Most valuable real bugs caught by the loop (all in canonical `shared/`):

- **anthropic-http SSE chain**: the streaming→non-streaming fallback was dead code
  (loop-top re-enabled `body.stream`); fixing it exposed that a downgrade on the final
  attempt fell out of the loop returning `undefined`, and that the SSE body read had no
  stall watchdog at all. Now: mutable `useStream`, downgrade doesn't consume an attempt,
  backstop `retries exhausted` throw, per-read idle timer with reader.cancel().
- **codex withSharedClient**: timeout path called `release()` immediately, resolving the
  waiter's lock-chain placeholder while the previous holder still ran — mutual exclusion
  break. Fixed with `prev.then(release)`; only the timed-out waiter rejects.
- **spawn-child streaming**: onText dropped lines split across chunk boundaries and the
  unterminated tail at close; short (argv) prompts returned `usage: null`. Now line-buffered
  + close-drain + universal `--output-format stream-json`.
- **fabric run_task** never forwarded `cwd` (child silently ran in the temp runDir);
  gained `timeoutMs`, `passthroughAuth` (defaults on for native claude).

## Fabric engine validated live (twice)

- **codex git-tidy write-mode task** (`shared/codex/task.mjs` runCodexTask, write:true, cwd
  → scratch repo): passed — codex invoked its own git-tidy skill, squashed 3 dirty commits
  into one conventional commit, file bytes unchanged. codex-cli 0.142.3 returns **no usage**
  in `turn/completed` (upstream protocol change; engine extraction gets null).
- **deepseek advisory via spawnChild** (model `claude-opus-4-8` → alias-remapped to
  `deepseek-v4-pro`): worked end-to-end, usage returned (24.7k in / 5.7k out).

## KNOWN OPEN BUG — extractStreamText double-counts

`shared/spawn-child.mjs` `extractStreamText` accumulates assistant-message text AND the
final `result` message text. Providers whose `result` repeats the full assistant text
(deepseek does) yield `res.stdout` containing the answer **twice**. Needs dedupe — e.g.
prefer `result` over accumulated assistant text when both present, or track that assistant
text was already emitted. Not yet filed as an SR finding.

## Pending decision — git tidy of the branch

DeepSeek's advisory for `feat/substrate-observe-proxy` (11 unpushed commits): squash to 4 —
(1) feat(fabric) plugin intro [5a73360+1c744f6+757fefa+9ac8df2], (2) feat(fabric) codex
support [b90fcc5+ff74fa3], (3) refactor(shared) engine unification [1d5e89a+e19ee6a+0083753],
(4) refactor sharp-review polish [1c4c872+f5ec4ca]. User has NOT yet approved the rebase.
