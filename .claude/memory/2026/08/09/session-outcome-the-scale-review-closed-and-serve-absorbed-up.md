---
name: session-outcome-the-scale-review-closed-and-serve-absorbed-up
description: all 2026-08-09 scale-review findings fixed in one day (f68c5c4, suite 305/0, v0.1.11 pushed); serve absorbed up as the single entrypoint; what changed shape and what the operator must know
metadata:
  type: project
---

# Session outcome: the scale review is closed and serve absorbed up

Closing commit f68c5c4 (+ status flip e4f2451), pushed; fabric v0.1.11, marketplace
v2.5.13. Full suite 305/0 run SERIALLY (the tests/*.test.mjs glob pulls in live/network
suites — a concurrent run collides with other lanes; run it once at integration time).
Findings and per-SR detail: `.claude/memory/2026/08/09/sharp-review.md` (all FIXED with
sha; SR-056 lists the load-bearing choices to preserve).

Shape changes a future session must know:

- **`scripts/up.*` no longer exists.** `serve.mjs` is THE entrypoint: node server +
  console, both idempotent, `--no-console` to opt out, `--status` now reports
  `maxSessions`/`sessions_count` (absent on old builds — a version fingerprint).
- **`openWriteSession` is gone at the source.** write:true claude/API sessions are
  persistent stream-json children; capability is expressed through the profile machinery
  (unprofiled: full write tools + bypassPermissions; profiled: the profile's tools and
  permissionMode || 'default').
- **Journal is per-process** (`journal-<pid>.jsonl`, merged on read, `compactJournal()`,
  owner `{pid, kind}` — serve sets kind via `setJournalOwnerKind('serve')`).
- **Remote calls time out** (`REQUEST_TIMEOUT`, distinct from `CONNECTION_LOST`) and ride
  ONE pooled TLS connection per peer with keepalive + heartbeat.
- **`serve.maxSessions`** (default 64) refuses spawns with `CAPACITY_CEILING` — a static
  operator invariant; dynamic admission stays in the swarm layer by the approved
  architecture (motronics:
  `design-final-architecture-collaboration-and-test-system-unified.md`).
- **Operator fact:** serve's session children do not die with serve — orphans by design;
  clean by CommandLine-matched Stop-Process, then clear records in the console. Candidate
  improvement (not implemented, user to decide): serve exit closes owned non-shared
  sessions.
