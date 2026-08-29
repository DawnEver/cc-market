---
name: console-v3-frontend-rewrite
---

# fabric console v3 — full frontend rewrite (option B), async probes, context window

Session 2026-08-11. The fabric management console was rewritten first-principles (option B:
ES modules, no build). Commits in cc-market/fabric (`47a2ede`, `5d008f8`, `15a1a12`,
`54f3c59`, `4709437`, `3718b91`). Detailed plugin-engineering record lives in
cc-market/fabric memory (`console-v3-transcript-truth-async`, `console-v3-iteration2-context-attach`).

## Decisions

- **Console = fabric FACTS surface + spawn/session triggers.** Every UI element is a
  projection of a fabric fact; the frontend never invents state.
- **Transcript-as-truth chat.** Renders the session's own transcript (`/view`); codex
  (`content:null`) falls back to the console's local log, labelled. Foreign non-shared
  peer sessions open in read-only OBSERVE mode (node/view is visibility, not acting).
- **Freeze root cause found & fixed**: catalogue probes were SYNC (`execFileSync` claude
  ≤15s + codex `spawnSync` doctor ≤40s) and blocked the single-threaded HTTP server on
  every catalogue refresh, freezing all polls. Probes are now async
  (`checkCodexStatusAsync`, `liveCatalogue` async + in-flight coalescing). Verified live:
  fleet answers 0.23s while the catalogue probes.
- **render.js is a tiny keyed vnode patch** — no innerHTML, one delegated `data-action`
  dispatcher (handlers stable across patches), container semantics. Crashed twice in the
  field: text leaves aren't in `el.children` (use `childNodes`), and mount/patch must
  treat the container as holding the vnode element (`childNodes[0]`) — guarded by a DOM
  shim test suite.

## Structure

`web/public/` = state.js (pure derivations, tested) · render.js (keyed patch) · main.js
(polling + orchestration). Display formatters served from `scripts/lib/format.mjs` via
`/lib` (one source). No build step; static files re-read per request (browser hard-refresh
applies frontend changes; engine changes need a serve restart).

## Status

Tests 398, 397 pass, 0 fail (1 pre-existing win32 skip). Operational: peers run old code
until updated — ctx% and attached-identity need the serve restarted on each box.
