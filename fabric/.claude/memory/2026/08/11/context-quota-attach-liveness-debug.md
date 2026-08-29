---
name: context-quota-attach-liveness-debug
---

# Debug session: context quota "full in two rounds" + attached sessions shown dead/duplicated

User-reported (2026-08-11): fabric persistent sessions show context 100% after ~2 rounds;
and the fleet dashboard lists multiple "same-name" sessions across G and WS1, with attached
sessions marked `dead`. Diagnosis below is from LIVE data (sessions `sess-1-msp7u3fs` on G /
`sess-4-msp7rsdw` on WS1, the motronics integration task). **All four findings fixed in the
same session (SR-055 context, SR-056 attach); uncommitted at time of writing.**

## How context quota is supposed to work

- `engine/context.mjs:17-25` — window LIMIT table from model id: `[1m]`→1M, `256k`→256k,
  `128k`/`200k`, `^claude-` + bare aliases (haiku/sonnet/opus/fable)→200k. Unknown → null
  → UI shows raw tokens, no %.
- `engine/open-session.mjs:314-315` — on each `result` event, `contextTokens =
  input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (the LATEST turn's
  full-prompt tokens).
- `engine/session.mjs:406` — `context_limit: contextLimitFor(e.model)` rides every
  listSessions row.
- `web/public/state.js:134-143` — `pct = min(100, used/limit)`, null-safe.

DESIGN PREMISE: "the latest turn's full-prompt tokens = current window occupancy" — only
true when ONE turn = ONE API request.

## Bug 1 (confirmed) — context_tokens is a turn-SUM, not a prompt size

Live numbers from `sess-4-msp7rsdw` (model sonnet, context_limit 200000, 3 turns):

```
usage (CUMULATIVE): input_tokens 42 · output_tokens 13688 · cache_creation 73100 ·
                    cache_read 1251605 · total_input 1324747 · cost 1.88 USD
context_tokens (LATEST turn): 932439   →  466% of the 200k window → clamped 100%
```

Why: Claude Code stream-json's `result` usage aggregates ALL internal API sub-requests in
the turn (each tool-call round re-sends the whole cached prefix). A turn running ~10 tool
sub-requests × ~93k cached prefix ≈ 932k. The 200k window was actually ~46% full — the
display overstates by roughly the sub-request count. `cost 1.88` over 13.7k output tokens
confirms ~200k-sized legal requests, NOT a real 1M+ prompt (a real 932k prompt on sonnet
would be rejected). Each individual request was legal; the SUM is what's bogus.

`input_tokens` cumulative 42 also confirms near-total caching (everything beyond the tiny
fresh tail is a cache read), so the true occupancy ≈ cached prefix ≈ 73-93k.

### Fix (landed, SR-055)
`engine/open-session.mjs` result handler now computes
`contextTokens = per-turn input_tokens + cumulative cache_creation_input_tokens` —
fresh non-cached input + distinct content ever written to cache. `cache_read` (the
re-read term) is EXCLUDED, so a tool-heavy turn no longer multiplies the fill by its
sub-request count. Works for cached AND non-cached providers (creation 0 + input =
whole prompt either way). Live case drops 932k → ~73k (37% of 200k). `total_input_tokens`
(cumulative, INCLUDING re-reads) stays the cost-side consumption signal. `state.js`
`contextStatus` + console tooltip label it `(est.)`. Test: huge-cache_read turn asserts
`context_tokens` stays small while `total_input_tokens` still counts the reads.
- Rejected: exact per-request size is unrecoverable from the summed result usage (Option
  C — observe-proxy capture — is the only exact path, opt-in/overhead).
- NOTE: old running processes still report the old inflated value until restarted.

## Bug 2 (confirmed) — attached sessions show `dead` + stale turns

On G, both attached sessions render `attached dead turns=2`/`turns=1`; the underlying WS1
sessions are `alive` with `turns=3`/`turns=1`.

- `engine/session.mjs:384-386` `observedAlive`: `'alive' in handle ? !!handle.alive : null`.
  `remoteHandle` (`engine/node-client.mjs:233`) DEFINES `alive: null` as an own property,
  so `in` is true → `!!null = false` → any remote/attached handle that has never been
  `ping()`ed reads as DEAD, not "unknown".
- Attach captures `turns`/`usage`/`compacted` ONCE at attach time (`session.mjs:361-369`,
  via `handle.view`) and never refreshes — the underlying session advanced (2→3 turns) but
  the registry copy didn't.

### Fix (landed, SR-056)
- `observedAlive` (`engine/session.mjs`) returns `typeof handle.alive === 'boolean' ? a :
  null` — an un-pinged remote/attached handle (own prop `alive:null`) now reads as
  UNKNOWN, never dead. Console dot already renders null as ok; fleet label is three-state.
- Attached sessions refresh live facts from the peer on a cadence: `attachSession` starts
  an unref'd 8s interval (env `FABRIC_ATTACH_REFRESH_MS` to shrink; read at call time for
  tests) that pings the peer handle and copies turns/usage/compacted into the registry
  entry. Timer cleared on close/loss/`_resetRegistry`. `node/ping` (`pingSession`) now
  also returns usage/compacted/context_limit, and `absorbFacts` absorbs compacted — so the
  refresh needs only node/ping, no content tail. Attached sessions therefore show the SAME
  live turns/usage/ctx% as a local one (the "unified experience" ask).

## "Duplicate same-name sessions" — attach convention + a raw-dashboard gap (fixed)

- G's `sess-1-msp7u3fs` / `sess-2-msp7utf3` are ATTACH handles to WS1's
  `sess-4-msp7rsdw` / `sess-2-msp7rk89` — ONE conversation, two references (attach
  convention: adopt a remote session so G can drive it). Web console dedups across
  machines by nativeId (`state.js:61-79` uniqueSessions; `state.js:98-103` sessionsOf).
- FIXED (SR-056): the RAW `list_nodes` MCP tool now dedupes too — an attached row whose
  nativeId matches a rendered native copy is dropped, and the native copy is annotated
  `[attached@<machine>]`; an attach row survives only when its native copy is absent (peer
  down). `alive` label is three-state (`dead|alive|unknown`). The web console dedup was
  already correct; only the raw tool showed both rows.
- "Same name" is also a visual collision: local ids (`sess-2-msp7utf3`) vs peer native ids
  (`sess-2-msp7rk89`) both start `sess-2-` — they are different sessions and now each
  renders once.

## How to re-debug (repro steps)

1. `list_nodes` — fleet + per-node sessions (id, provider, alive, turns). Attach handles
   appear under the machine that attached them with LOCAL ids.
2. `session_view {node, remoteId}` on the attach id → returns the PEER session's real
   id/pid/turns/content. Confirms attach→native mapping (sess-1-msp7u3fs → sess-4-msp7rsdw).
3. Read `~/.fabric/journal.jsonl` (this machine) — spawn events carry local id +
   `nativeId` + node (e.g. `sess-b-msp7rjie → sess-2-msp7rk89 @ WS1`). Other processes
   write `journal-<pid>.jsonl` / `journal-compact.jsonl`.
4. `contextStatus(session)` in `web/public/state.js` — the used/limit/pct derivation.
5. For attach identity, note the registry entry snapshot vs the peer's live node/view.
