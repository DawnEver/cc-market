# Fabric Invariants

Always-injected dev-only constraints for working on the fabric plugin. Runtime behavior is
documented in `README.md` / the MCP tool schemas — don't restate it here.

## Per-session ops: ONE serialization point (engine/session.mjs)

Every mutating per-session registry op MUST go through `serializePerId` and MUST check
`rejectIfBusy(entry, id)` synchronously before queueing (send/compact/setGoal/goalRun/
close do both). `rejectIfBusy` gates on two flags: `closing` (set by closeSession —
rejects every new op) and `goalRunning` (set by goalRunSession — rejects every op
except the close kill-switch). The check must be SYNCHRONOUS, not inside the chain
task: checking at execution time accepts the op and fails it when its turn comes —
exactly the queue-behind-a-close ordering the flags prevent. When adding a new
per-session op, follow the same two lines or concurrent callers will interleave into
one child (the peer's child has a SINGLE pending slot). closeSession during a goal run
skips the chain on purpose (kill switch; open-session's loop sees `closed` at the next
turn boundary) — do not "fix" it back into the queue, that blocks a close for up to
the run's full timeout.

## Attach is idempotent — keep it that way

`attachSession` returns the existing registry entry for an already-attached
`(node, remoteId)` (`existing: true`) and shares in-flight attaches via
`attachInflight`. A duplicate handle is a double-count/double-warn bug in every
consumer (console, MCP list). Any new attach path must reuse `attachSession`, never
register a remote handle directly.

## Spawn admission is atomic (engine/node-server.mjs)

The `maxSessions` ceiling check counts `_listSessions().length + admissions`, and
`admissions` increments SYNCHRONOUSLY before the first `await` of a spawn (released in
`finally`). The check and the increment must stay in the same synchronous stretch —
an await between them re-opens the check-then-act race a team_spawn fan-out exploits.

## Observe proxy: request/response asymmetry

The proxy **buffers** the request body (it must parse and remap the model id before
forwarding) but **streams** the SSE response back unbuffered. Never buffer the response —
buffering breaks streaming clients and stalls long generations. Any change to
`observe-proxy.mjs` must preserve this asymmetry.

## OAuth providers use passthroughAuth

For OAuth providers (`claude`), the proxy must be started with `passthroughAuth: true` so
it forwards the child's own (self-refreshing) Authorization header. The proxy must never
hold or inject claude credentials — only static-key providers (e.g. DeepSeek) get a key
injected.

## Codex is native — never route it through the observe proxy

Codex speaks its own app-server protocol (OpenAI-side), not Anthropic HTTP. It cannot ride
the `spawnChild`/proxy path; keep the `provider === 'codex'` branch dispatching to
`engine/codex/task.mjs` and reject any temptation to "unify" it behind the proxy.

## windowsHide applies to the MCP server

Every `spawn`/`execFileSync` in `scripts/mcp-server.mjs` and the engines it calls launches
from a console-less parent — pass `windowsHide: true` unconditionally. See
`cc-market/.claude/rules/invariants.md` for the full rule.

## engine/ is canonical, shared/ is a bundled copy

The L0 session/execution engines live in `fabric/engine/` — **fabric-owned canonical
source, edit directly**. They were pulled out of `cc-market/shared/` once takeover was
absorbed and fabric became their sole consumer, so other plugins no longer bundle them.

`fabric/shared/*` is still a bundle of `cc-market/shared/` (now just the cross-plugin
generic utils: `spawn/lib/state/stamp/attention`) — never edit the copies here; edit the
canonical `cc-market/shared/` source, the pre-push hook rebundles. `engine/` reaches
`spawn.mjs` via `../shared/spawn.mjs`, which is why fabric keeps a bundled `shared/`.

## Tests

Run: `node --test cc-market/fabric/tests/*.test.mjs`. Pre-commit hook enforces.
