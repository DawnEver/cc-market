---
created: 2026-08-10
description: native session compaction for codex AND claude, the shared+attach cross-machine convention, and the answer to "why can't I drive other workstations' sessions from G" — session ownership is per-connection by design
---

# Session compact + the shared+attach convention (2026-08-10)

## The "why can't G drive WS1/WS2 sessions" answer

By design, not a bug. Three layers: (1) a session lives in the registry of the PROCESS
that spawned it (engine/session.mjs in-process Map — MCP server and serve have separate
registries); (2) a peer session is owned by the CONNECTION that spawned it
(node-server.mjs `owned.add`, socket drop reaps, `node/send|close` reject foreign ids);
(3) the console chats only with sessions this process spawned (web/api.mjs header
comment). Foreign sessions are observable via node/status but read-only.

The one cross-machine path, agreed with the user 2026-08-10: **spawn `shared: true` and
attach** — shared sessions accept any token-holder's send/close/compact and survive the
spawner's disconnect; the console already attaches on first click (`POST /api/attach`).
Convention: if a session may need driving from another machine, spawn it shared from the
start (shared-ness cannot be added later). Documented in README § LAN nodes step 5.
MCP `spawn_session` now exposes `shared` (was plumbed but not surfaced).

## Native compaction — BOTH major backends, no summarize-and-restart

User asserted "codex 和 claude 都有 compact 功能" — they were right; verified in the
protocols and live:

- **codex**: `thread/compact/start {threadId}` in the app-server protocol (v1 + v2;
  `ThreadCompactStartParams`). Completion: `context_compacted` notification or a
  compaction/context_compaction item on `item/completed`.
- **claude**: the CLI's manual compact IS reachable headlessly — a `/compact` user
  message on the stream-json child (the Agent SDK does exactly this:
  `query({prompt:"/compact", options:{continue:true, maxTurns:1}})`). The child emits
  `system:compact_boundary` with `compact_metadata {trigger:"manual", pre_tokens,
  post_tokens, cumulative_dropped_tokens, preserved_segment}` BEFORE the result event.
  Probed live 2026-08-10: 30.8k → 1.2k tokens; a recalled fact survived the compact.
  Caveats: needs ≥2 prior exchanges ("Not enough messages to compact" otherwise — a
  result with NO boundary = refused, reported `confirmed:false`); `--autocompact`'s 100k
  minimum is enforced so it cannot force an earlier compact (auto-window only, useful as
  a spawn option later, not wired).

Shipped surface: `compact()` on both handles (`compactable` fact on listSessions/ping,
null = unknown) · registry `compactSession(id)` (journals a `compact` event,
`COMPACT_UNSUPPORTED` for backends without one) · MCP `session_compact` · node protocol
`node/compact` (same ownership gate as send/close, shared sessions drivable) ·
console compact button (`POST /api/sessions/:id/compact`). Remote handles forward to the
peer, so compaction runs on the machine that owns the child.

Suite: 331 pass. My earlier claim "claude has no headless compact" was wrong — the
protocol message is just a user message, which the SDK docs document and the live probe
confirmed.
