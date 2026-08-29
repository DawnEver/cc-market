---
name: console-v3-transcript-truth-async
---

# Console v3: transcript-as-truth chat + non-blocking catalogue probes

Full frontend rewrite of the fabric management console (commit `47a2ede`), P0–P3 of the
v2 IA from `2026/08/09/design-console-v2-information-architecture.md`, done as option B
(ES modules, no build). Three live bugs found and fixed along the way.

## The freeze root cause (why probing hung)

`engine/catalogue.mjs` ran **synchronous** probes: `execFileSync(claude --version)`
(≤15s) and — via `checkCodexStatus` — `spawnSync(codex --version)` + `spawnSync(codex
doctor --json)` (≤40s total). The web server is single-threaded, so every catalogue
refresh (first load + ⟳) BLOCKED the event loop for up to ~40s; fleet/chat polls queued
behind it and the UI appeared frozen. Verified live after the fix: fleet answers in
0.23s while the catalogue probes.

**Fix:** probes are now async (`checkCodexStatusAsync`/`findCodexBinaryAsync` in
discovery.mjs, `liveCatalogue` is async with in-flight coalescing). The sync twins stay
for the DISCRETE callers (MCP `codex_status`, app-server constructor) where blocking is
acceptable — only the poll path had to be non-blocking. `versionOf`/`runAsync` promisify
`execFile` with `windowsHide: true`.

## Transcript-as-truth chat (the honesty gap)

The old chat rendered the console's in-memory log — attaching a shared session showed an
empty conversation that was actually long. The console now renders the session's OWN
transcript (`/view`; claude/API always record one), and the local log is only the
fallback for codex (`content:null`, labelled). Foreign non-shared peer sessions are
OBSERVE-only: read-only `/view` (node/view is visibility, not acting), composer disabled
with the reason shown — instead of a scope-lying disabled button.

## Engine facts the UI needed (source fixes)

- **`listSessions` now exposes `nativeId`** (the handle's id; for a remote session that
  IS the peer's id). Without it, a remote session spawned from the console appeared
  TWICE (console registry + the peer's node/status). `state.sessionsOf` dedups via
  `nativeId`.
- **Registry records resolved model/effort/project** (sessionDefaults applied at spawn)
  so cards name what a session RUNS, never a re-spelled default. Descriptor + journal
  carry them too.
- **`/api/nodes/:node/sessions/:id/view`** — foreign observe route; `/api/nodes` removed
  (dead — `/api/fleet` replaced it).

## Frontend structure (option B)

- `web/public/state.js` — PURE derivations, zero browser deps, **tested**
  (`tests/web-state.test.mjs`): parseTranscript, viewMessages, aggregateFleet,
  sessionsOf, canDrive, sessionKey.
- `web/public/render.js` — keyed vnode patch. No innerHTML (text via textContent — the
  old console interpolated fields into markup). Events NOT per-node: elements carry
  `data-action` and ONE delegated dispatcher in main.js handles them, so patch() never
  touches listeners and handlers stay stable. Small `tag.cls` DSL in `h()`.
- `web/public/main.js` — polling + orchestration. Poll guards (`fleetBusy`/`chatBusy`)
  skip a tick if the previous refresh is still in flight. Toasts (no alert). Chat
  auto-scrolls only when near bottom (forced scroll every 2.5s made reading impossible).
  `server.mjs` serves `scripts/lib/format.mjs` via `/lib` so the browser imports the ONE
  formatter source instead of re-spelling fmtUptime/fmtMem/fmtAgo.

## Misc

- `openSession` tries `/api/attach` FIRST for a foreign session; a shared session
  attaches → drivable, a non-shared one fails → observe. `sessCard`'s `data-id` is the
  console id for mine (drives `/api/sessions/:id`), the peer id for foreign.
- Orphans render under their machine (node, else this machine).
- Removed the dead `app.js` (invariants: delete what a change orphaned).
- Suite: 387 tests, 386 pass, 0 fail (1 pre-existing win32 skip).
