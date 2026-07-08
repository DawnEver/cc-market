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
`shared/codex/task.mjs` and reject any temptation to "unify" it behind the proxy.

## windowsHide applies to the MCP server

Every `spawn`/`execFileSync` in `scripts/mcp-server.mjs` and the engines it calls launches
from a console-less parent — pass `windowsHide: true` unconditionally. See
`cc-market/.claude/rules/invariants.md` for the full rule.

## shared/ files are bundled copies

`fabric/shared/*` is a bundle of `cc-market/shared/` — never edit the copies here. Edit
the canonical `cc-market/shared/` source; the pre-push hook rebundles.

## Tests

Run: `node --test cc-market/fabric/tests/*.test.mjs`. Pre-commit hook enforces.
