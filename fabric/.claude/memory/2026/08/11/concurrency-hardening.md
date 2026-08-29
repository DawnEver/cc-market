---
name: concurrency-hardening
---

# Concurrency hardening for dozens-of-agents scale

Session 2026-08-11 (fanned out to a subagent, diff reviewed inline). Five edge cases
from the audit, all fixed at the ENGINE so every caller (MCP, console API, node
server, teams) inherits the guarantee. 6 new tests; suite 414, 0 fail.

## The five

1. **Duplicate attach** — attaching the same remote session twice stacked two registry
   entries (the console double-counted/double-warned; seen live as "G · sess-X" AND
   "WS2 · sess-X" attention rows for one conversation). `attachSession` is now
   idempotent: registry scan on the EXACT registration key `(nodeName, handle.id)` →
   `existing: true`, and `attachInflight` shares simultaneous attaches so the handle
   factory runs once. nodeName normalization must equal the registration line (a name
   and its inline-object spelling).
2. **close vs in-flight send** — close used to kill the child mid-turn, losing the
   turn. Now close queues on the per-id chain (graceful) and sets `closing`
   SYNCHRONOUSLY so later ops reject fast instead of queueing behind the close.
3. **goal run vs other ops** — registry-level uniform refusal via `goalRunning`
   (handle-level guards were claude/API-only). **close is the kill switch**: it skips
   the chain during a goal run (open-session's loop sees `closed` at the next turn
   boundary) — never queue a close behind a 30-minute run.
4. **compact/setGoal unserialized** — all five mutating ops now go through the ONE
   per-id chain (renamed sendChains → opChains) + `rejectIfBusy` synchronous gate.
5. **spawn ceiling check-then-act** — node/spawn checked `_listSessions().length`
   then awaited the spawn; a team_spawn fan-out overshot. `admissions` counter:
   counted in the check, incremented synchronously before the first await, released in
   `finally`. Single-threaded atomicity — the check and the increment share one
   synchronous stretch.

## Invariants recorded (fabric/.claude/rules/invariants.md)

- New per-session op ⇒ `serializePerId` + synchronous `rejectIfBusy`. A check INSIDE
  the chain task accepts-then-fails — the ordering bug the flags exist to prevent.
- New attach path ⇒ reuse `attachSession`, never register a remote handle directly.
- node/spawn: check and `admissions++` in the same synchronous stretch.
- node/status and node/view share ONE `projectForCwd` — same-session fix: an attached
  handle learned `project:null` from the raw registry view while node/status grouped
  the same session under its alias (reverse-mapped from cwd), so the console showed
  "attached — no project recorded" next to a correctly-grouped native entry. The view
  now reverse-maps too, and attach lands under its project. Test gotcha: deps are
  captured at createNodeServer construction — overriding a dep between requests does
  NOT take effect; answer per-id instead. Peers need a serve restart for this (engine
  code), same rule as every engine change.

## Method note

Fan-out worked well here: the engine files (session.mjs, node-server.mjs) had zero
overlap with the simultaneously-developed console conveyor UX — two workstreams, one
suite, no conflicts. The subagent was told NOT to commit; the diff was reviewed
inline before committing (ground truth over the agent's report).
