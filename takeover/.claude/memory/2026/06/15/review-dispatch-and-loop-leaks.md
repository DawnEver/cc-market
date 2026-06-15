---
name: review-dispatch-and-loop-leaks
description: Why sharp-review consumed no deepseek/codex tokens — review mode unsupported for non-codex providers + three event-loop leaks that hung tests ~5 min
metadata:
  type: project
---

# Review Dispatch + Event-Loop Leaks (sharp-review zero-token root causes)

Two independent root causes behind "sharp-review shows no deepseek/codex token consumption".

## 1. review mode rejected for non-codex providers

`mcp-server.mjs` dispatch maps: `API_DISPATCH` (deepseek) and `CLAUDE_DISPATCH` (sonnet) only
had `task` + `agent` handlers — no `review`. Only `CODEX_DISPATCH` had `review`.

sharp-review's workflow sends `mode="review"` to ALL reviewers in review mode (diff inlined).
So non-codex reviewers (B=deepseek, C=sonnet) threw `Mode "review" is not supported for
provider "deepseek"`, the subagent fell back to `StructuredOutput { findings: [] }`, and those
reviewers silently produced nothing. Combined with the codex TDZ crash (see
`takeover-architecture` / `_pendingCount` fix), review mode had **zero working reviewers**.

**Fix:** add `review` to `API_DISPATCH` and `CLAUDE_DISPATCH`, aliased to the task handler.
The adversarial review system prompt is already built from `mode` in `handleCallModel`
(`buildPrompt('review')` → `prompts/review.md`), so non-codex review = task + review prompt.
Codex keeps its native `review/start` endpoint. Runtime-visible behavior lives in the
`call_model` tool `mode` schema description (NOT dev-only `invariants.md`).

**Token accounting was already correct** — `callAnthropicAPI` usage → `takeover_traces.jsonl`
→ traceme `daily_takeover`. Tokens were zero only because the calls errored out.

## 2. Three event-loop leaks (tests/CLI hung minutes)

- `app-server.mjs`: child `error`/`close` handlers rejected pending requests but never
  `clearTimeout`'d their (up to 10-min `send()`) timers. Extracted `_rejectAllPending(err)`
  that clears each timer then rejects.
- `lib.callAnthropicAPI`: `AbortSignal.timeout(300000)` was never cleared/unref'd → 5-min
  leak after fetch settled. Replaced with `AbortController` + clearable, **unref'd** global
  timer. Gotcha: `setTimeout` is shadowed by `import { setTimeout } from "node:timers/promises"`
  at the top of `lib.mjs` — must use `globalThis.setTimeout` for callback timers.
- `lib.stdinSpawnClaude`: the child_process `timeout` option is never cleared on spawn ENOENT
  (Node emits `error` but not `exit`), leaking a 5–10 min internal kill timer. Replaced with
  `armKillTimer(child, ms)` — unref'd, cleared on close/error.

**Result:** full takeover suite 90/90 in ~5s (was hanging ~5 min). The pre-commit hook runs
`takeover/tests/*.test.mjs` as a glob — a single leaked handle there hangs the whole hook.

## Validation
- Live: `call_model(provider=deepseek, mode=review)` — needs `/reload-plugins` after the fix
  (running MCP server holds stale code until reloaded).
- Tests: added `_rejectAllPending` + review-dispatch regression tests; `node --test
  cc-market/takeover/tests/*.test.mjs` → 90/90, rc=0.
