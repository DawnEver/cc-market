---
created: 2026-08-10
description: goal = fabric-side marker loop (the CLI's native /goal is UNREACHABLE in the hook-free child architecture — three probes), plus serve crash recovery (sessionId capture, --resume continue, kill/tombstone decide)
---

# Goal (autonomous run) + serve crash recovery (2026-08-10)

## Goal: fabric-side marker loop — the CLI's /goal is unreachable, proven

User asked for a "goal" feature so sessions work autonomously without lots of
interaction. The CLI 2.1.226 HAS a native `/goal <condition>` (auto-continues turns
"until it's met" — probed live: one user message drove ~7 autonomous iterations). BUT
it is physically unreachable in fabric's child architecture:

- fabric children run `--settings '{"disableAllHooks":true}'` (hook-free policy,
  deliberate) → `/goal` REFUSES: "can't run while hooks are restricted".
- With hooks enabled on the ISOLATED config dir (API providers) → the CLI **hangs at
  startup** (probed three settings shapes: `{}`, `{"disableAllHooks":false}`, a real
  settings.json with `hooks:{}` — all stall; only disableAllHooks:true boots).
- With hooks enabled on the REAL config dir → /goal works but the USER's hooks fire
  in the child (policy violation; sharp-review Stop-hook recursion risk).

So the shipped goal loop is FABRIC-SIDE and provider-independent: `setGoal(condition)`
stores locally (no CLI call); `goalRun` sends the trigger with a completion-marker
protocol ("work autonomously toward the goal; when done, end your final reply with
exactly `<<GOAL_COMPLETE>>`") and iterates until the marker appears, capped by maxTurns
(20) / timeoutMs (30 min). State honest: `met|capped|timeout`; timeout leaves the child
alive (the work may be worth keeping). Live E2E: one run → `met`, condition satisfied.
Mid-run interjections refused. Surface: handle.setGoal/goalRun, registry
setSessionGoal/goalRunSession (journal goal_set/goal_run, GOAL_UNSUPPORTED for codex),
MCP session_goal, node/goal (peer runs the loop), console goal box + run log line.

## Crash recovery: journal already knew; now the operator decides

The journal (G4) recorded spawn/close/loss with pid liveness; what was missing was the
DECIDE path and the reminder. Shipped:

- openSession now captures the CLI's own `session_id` from the init event → journaled
  on spawn → resumable. `--resume <id>` restores the conversation from the CLI's
  session store (a new child, same conversation).
- `serve` prints a startup reminder listing survivors (alive / unknown-remote /
  resumable) — the "kill-or-adopt is the layer above's decision" promise, now concrete.
- Console orphans panel: **continue (resume)** → spawns a resumed child, journals a
  loss linking the lineage ("resumed into <id>"); **kill** (provably-alive pids only,
  then tombstone); **clear record** as before. Remote orphans: resume refused honestly
  ("the peer owns it; resume it there") — the peer's own console decides.

Not built (swarm's): remote resume via node protocol (node/resume), auto-adopt policies.

Suite: 346 pass. Commit `2a1f3c0`-style (see git log).
