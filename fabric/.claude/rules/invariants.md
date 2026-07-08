# Fabric Invariants

Always-injected dev-only constraints for working on the fabric plugin. Runtime behavior is
documented in `README.md` / the MCP tool schemas — don't restate it here.

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
