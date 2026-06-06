# Takeover Plugin — AGENTS.md

Multi-model AI orchestration via MCP. Routes tasks to Claude, Codex, DeepSeek, or any Anthropic-compatible API.

## Architecture

```
/takeover:continue "review this" --provider deepseek
  → Agent(takeover:takeover)
    → Gathers local context (git diff, file reads)
    → MCP tool: call_model(provider=deepseek, mode=task, userPrompt="...")
      → mcp-server.mjs reads claude_env_settings.json
      → Routes to: Anthropic API | Codex companion | Native Claude CLI
      → Returns output verbatim via takeover-result skill
```

## File Structure

```
takeover/
├── scripts/
│   ├── lib.mjs              Core: provider config, API callers, retry, text extraction
│   └── mcp-server.mjs       MCP stdio server (JSON-RPC): call_model + list_models
├── agents/takeover.md       Subagent: context gathering + handoff
├── commands/
│   ├── continue.md          /takeover:continue
│   ├── models.md            /takeover:models
│   └── summary.md           /takeover:summary
├── prompts/
│   └── task.md              System prompt for code/investigation
├── skills/takeover-result/  Result handling: return verbatim, no paraphrasing
├── tests/
│   ├── lib.test.mjs         27 tests — provider config, model resolution, API, retry
│   └── mcp-server.test.mjs  10 tests — TOOLS schema, JSON-RPC, validation
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md + @.claude/rules/*.md
└── AGENTS.md                This file
```

## Key Invariants

See `.claude/rules/invariants.md` for the always-injected version.

- **Prompt via stdin**: `callCodexCompanion` and `callNativeClaude` pass prompts via stdin, never in spawn args.
- **Retry**: 429/502/503/504 → 2 exponential-backoff retries (1s, 2s). 4xx → fail immediately. Network errors → retry.
- **`--write` rejected early** for non-codex providers.
- **Config path**: Overridable via `TAKEOVER_CONFIG_PATH`. Default: `~/.claude/claude_env_settings.json`.
- **Foundry mode**: Read `CLAUDE_CODE_USE_FOUNDRY=1` from env block; uses `ANTHROPIC_FOUNDRY_BASE_URL` + `ANTHROPIC_FOUNDRY_API_KEY` instead of `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
- **MCP JSON-RPC**: `send()` writes JSON + newline to stdout. Errors use `-32601` (method not found) or `-32000` (server error).

## Provider Config

```json
{
  "env:deepseek": {
    "CLAUDE_CODE_USE_FOUNDRY": "1",
    "ANTHROPIC_FOUNDRY_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_FOUNDRY_API_KEY": "sk-...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash"
  }
}
```

`loadProviderConfig()` returns `{ native: true, provider: "claude"|"codex" }` for built-in, or `{ native: false, baseUrl, token, defaultSonnet }` for API providers.

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout. Exposes two tools:

| Tool | Input | Routes to |
|---|---|---|
| `call_model` | `provider`, `userPrompt`, `model?`, `mode?`, `write?`, `systemPrompt?` | `callAnthropicAPI` / `callCodexCompanion` / `callNativeClaude` |
| `list_models` | (none) | `listModels()` |

Exported for testing: `TOOLS`, `handleToolCall`, `handleCallModel`, `send`.

## Testing

```shell
node --test cc-market/takeover/tests/lib.test.mjs
node --test cc-market/takeover/tests/mcp-server.test.mjs
```

Pre-commit hook runs all 37 takeover tests + 87 rem tests. `callAnthropicAPI` tests mock `globalThis.fetch`. `callCodexCompanion` tests use a temp mock script that echoes stdin.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic. Export functions for testability where needed.
- Version bumping is automatic — the repo-level `pre-push` hook bumps this plugin's `plugin.json` whenever `takeover/` changed in the push.
