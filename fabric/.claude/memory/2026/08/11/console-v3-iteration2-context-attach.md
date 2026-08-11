---
name: console-v3-iteration2-context-attach
created: 2026-08-11
---

# Console v3 iteration 2: context-window %, full attached identity, render fixes

Second pass on the console rewrite (commits `54f3c59` `4709437` `3718b91`). Follows
`console-v3-transcript-truth-async.md`.

## Context-window occupancy % + compact

- `open-session.mjs` records **`context_tokens` = the LATEST turn's full-prompt tokens**
  (input + cache creation + cache read) — NOT cumulative. Each turn re-sends the whole
  context, so the latest input IS the current window usage; after a native compact the
  next turn's input drops, so the % falls with the window (the "compact freed the
  window" signal). Exposed via the `usage` getter + a `compacted` count
  (compact_boundary events).
- **`engine/context.mjs`** = the window LIMIT table, resolved from the model id:
  `[1m]`→1M, `256k`→256k, `128k`/`200k`, claude family + aliases (haiku/sonnet/opus/
  fable)→200k. Unknown model → null → the UI shows raw tokens WITHOUT a percentage
  (never fabricated). listSessions carries `context_limit` + `compacted` per row.
- Cards render `ctx N%` (or `ctx 84k` when the window is unknown) + `↻N` compact count;
  title tooltip shows `context used / limit`. `state.js contextStatus` derives the %.
- **Caveat:** the percentage is honest only on peers running this code — old peers lack
  `context_tokens` and fall back to cumulative `total_input_tokens` (a tilde-worthy
  approximation, labelled by nothing; acceptable).

## Attached sessions are full citizens

- **`node/view` (viewSession) now returns identity facts** — model/effort/project/cwd/
  turns/usage/compacted/context_limit — in the base object, so a peer's node/view and an
  attach learn them without a second round trip.
- **`attachSession` pulls that identity from the peer** into the registry entry
  (model/effort/project/cwd/turns/usage/compacted). An attached handle therefore shows
  full facts AND groups under its real project instead of "(no project)". A peer on old
  code returns none of it → honest nulls (`attached handle` label).
- **listSessions prefers the registry entry over the handle** for `usage`/`compacted`
  (`e.usage ?? e.handle.usage`): an attached remote handle exposes neither, and the
  entry captured them at attach time.

## render.js — two field crashes, both fixed + guarded

1. **`el.children[i]` misses text leaves.** A text vnode renders as a text node, which
   `children` (element nodes only) never contains → undefined.el, crash. Reconcile maps
   old children via **`childNodes[i]`** (text included, vnode order).
2. **Element-identity mismatch + attrs-as-vnode.** `mount` installed `createElement(v)`
   as the container's CHILD but `patch` reconciled the CONTAINER against the vnode —
   class/attr updates hit the wrong element; and `syncAttrs` was called with `.attrs`
   objects instead of vnodes, so `effectiveClass` read `.class` on undefined for text
   leaves ("Cannot read properties of undefined (reading 'class')"). Fix: **container
   semantics** — the vnode maps to `root.childNodes[0]`; `syncAttrs(el, oldV, newV)`
   takes vnodes; `effectiveClass` is defensive (`v?.attrs?.class`).
3. Guarded by **`tests/web-render.test.mjs`** — a minimal DOM shim (FakeNode/FakeText/
   FakeElement) covering text leaves, keyed append/remove/reorder, class merge, and
   chatEmpty→messages replacement.

## Misc

- Machines + Projects→Sessions panes are collapsible `<details class="fold">`.
- Clicking a machine re-renders the Machines pane immediately (`renderMachines()`), so
  the blue `.sel` box moves on click, not on the 6s poll.
- "(no project)" buckets/cards explain the reason: attached handle (no location) vs a
  real cwd outside every registered alias (cwd basename shown, full path on hover).
- Cards always show: provider · model · effort · turns N · ctx · ↻N · pid · loc · cost.

## Tests

+7 (context limit table, contextStatus, attach identity + old-peer degrade,
usage.context_tokens). Suite 398, 397 pass, 0 fail (1 pre-existing win32 skip).

**Operational:** the running serve loads engine modules at startup — ctx% / attached
identity / node/view identity need a **serve restart** (frontend static files only need a
hard refresh). Peers (WS1/WS2) show ctx tokens without % until their serves update.
