# Takeover Invariants

Always-injected behavioral constraints for working on the takeover plugin.

## Prompt via stdin

`callCodexCompanion` and `callNativeClaude` pipe prompts to the subprocess stdin — NEVER pass user content in spawn args. Args carry only flags (`--write`, `--model <name>`, `task`).

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
- `list_models` takes no params.

## Tests

37 tests across 2 files. Run: `node --test cc-market/takeover/tests/lib.test.mjs cc-market/takeover/tests/mcp-server.test.mjs`. Pre-commit hook enforces.
