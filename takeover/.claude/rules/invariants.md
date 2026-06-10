# Takeover Invariants

Always-injected behavioral constraints for working on the takeover plugin.

## Prompt delivery

- **Codex app-server**: prompts go in `turn/start` message body (JSON-RPC params), never in spawn args.
- **Codex exec** (images): prompt goes after `--` argument, via `spawn` args — this is the CLI convention for `codex exec`.
- **Native Claude**: prompt piped to subprocess stdin.
- **API**: prompt in HTTP request body.

## Codex app-server

- `CodexAppServerClient` spawns `codex app-server`, communicates via line-delimited JSON-RPC over stdin/stdout.
- No broker — one process per request. Simple, sufficient for handoff use.
- Initialize handshake (`initialize` with clientInfo) required before any other request.
- Notification routing: `onNotification(method, handler)`, dispatched from `_handleLine()`.
- Cleanup via `stop()` on completion or error. Kill child process on hang.

## Retry logic

| Status | Behavior |
|---|---|
| 429, 502, 503, 504 | 2 retries with exponential backoff (1s, 2s) |
| 4xx | Fail immediately |
| Network error / timeout | Retry if attempts remain |

`isRetryable(status)` in `lib.mjs` defines the retryable set.

## Provider config

- `loadProviderConfig("claude"|"codex")` — returns `{ native: true }`, no config read.
- `loadProviderConfig("<api>")` — reads `TAKEOVER_CONFIG_PATH` or `~/.claude/claude_env_settings.json`.
- Foundry mode: `CLAUDE_CODE_USE_FOUNDRY=1` → uses `ANTHROPIC_FOUNDRY_*` env vars. Direct mode: uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.

## MCP protocol

- `send(rpc)` writes `JSON.stringify(rpc) + "\n"` to stdout.
- Error codes: `-32601` for unknown method, `-32000` for server error, `-32602` for invalid params.
- `call_model` requires `provider` + `userPrompt` (non-empty). `--write` only valid for `provider=codex`.
- `mode` enum: `task`, `review`, `image-generate`, `image-edit`, `agent`. Review/image modes require `provider=codex`.
- `list_models` and `codex_status` take no required params.

## Mode flags

`parseCommandBlock()` extracts from `<command>` block:
- `--review` → `mode=review` (adversarial by default)
- `--image-edit` → `mode=image-edit`
- `--image` → `mode=image-generate`
- `--provider X` → provider override
- `--model X` → model override

## Tests

Run: `node --test cc-market/takeover/tests/*.test.mjs`. Pre-commit hook enforces.
