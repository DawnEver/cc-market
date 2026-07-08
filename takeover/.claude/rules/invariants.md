# Takeover Invariants

Always-injected behavioral constraints for working on the takeover plugin.

## Prompt delivery

- **Codex app-server**: prompts go in `turn/start` message body (JSON-RPC params), never in spawn args.
- **Codex exec** (images): prompt goes after `--` argument, via `spawn` args — this is the CLI convention for `codex exec`.
- **Native Claude**: via the shared child engine (`shared/spawn-child.mjs`) — argv for
  short prompts, stream-json over stdin for large prompts/images.
- **API**: prompt in HTTP request body.

## Codex app-server

- `CodexAppServerClient` spawns `codex app-server`, communicates via line-delimited JSON-RPC over stdin/stdout.
- No broker — one process per request. Simple, sufficient for handoff use.
- Initialize handshake (`initialize` with clientInfo) required before any other request.
- Notification routing: `onNotification(method, handler)`, dispatched from `_handleLine()`.
- Cleanup via `stop()` on completion or error. Kill child process on hang.

## Provider config

- `loadProviderConfig("claude"|"codex")` — returns `{ native: true }`, no config read.
- `loadProviderConfig("<api>")` — reads `TAKEOVER_CONFIG_PATH` or `~/.claude/claude_env_settings.json`.
- Foundry mode: `CLAUDE_CODE_USE_FOUNDRY=1` → uses `ANTHROPIC_FOUNDRY_*` env vars. Direct mode: uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.

## MCP protocol

- The server accepts both newline-delimited JSON-RPC and standard MCP `Content-Length` stdio frames. Keep newline support for Claude Code compatibility; keep framed support for Codex MCP startup.
- `send(rpc)` defaults to newline-delimited JSON for direct handler/tests. Runtime dispatch replies on the same transport used by the incoming request.
- Error codes: `-32601` for unknown method, `-32000` for server error, `-32602` for invalid params.
- `call_model` requires `provider` + `userPrompt` (non-empty). `--write` only valid for `provider=codex`.
- `mode` enum / per-provider support: documented authoritatively in the `call_model` tool schema description in `mcp-server.mjs` (the only runtime-visible source). Dev note: image modes are codex-only; `review` is dispatched for every provider (codex via its native endpoint, others aliased to the task handler) — keep the dispatch maps and that schema description in sync.
- `list_models` and `codex_status` take no required params.

## Codex + Foundry

Codex uses OpenAI API protocol internally (auth via `codex login`, not API keys). Foundry is an Anthropic API proxy concept (`ANTHROPIC_FOUNDRY_BASE_URL` / `ANTHROPIC_FOUNDRY_API_KEY`). These are incompatible protocols. `loadProviderConfig("codex")` always returns `{ native: true }` — no config read, no Foundry routing. Configure codex proxy at the CLI level (`codex config`), not through takeover's provider config.

## Tests

Run: `node --test cc-market/takeover/tests/*.test.mjs`. Pre-commit hook enforces.
