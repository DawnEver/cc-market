# Takeover Plugin — AGENTS.md

Multi-model AI orchestration via MCP. Routes tasks to Claude, Codex, DeepSeek, or any Anthropic-compatible API.

## Architecture

```
/takeover:continue "review this" --provider deepseek
  → Agent(takeover:takeover)
    → Gathers local context (git diff, file reads)
    → MCP tool: call_model(provider=deepseek, mode=task, userPrompt="...")
      → mcp-server.mjs reads claude_env_settings.json
      → Routes to: Anthropic API | Codex app-server | Native Claude CLI
      → Returns output verbatim via takeover-result skill

/takeover:continue --provider codex --review
  → Agent gathers git diff
    → MCP tool: call_model(provider=codex, mode=review, userPrompt="<diff>")
      → CodexAppServerClient → codex app-server → review/start (adversarial)
      → Returns findings verbatim
```

## File Structure

```
takeover/
├── scripts/
│   ├── lib.mjs              Core: provider config, API callers, retry, flag parsing
│   ├── mcp-server.mjs       MCP stdio server (JSON-RPC): call_model + list_models + codex_status
│   ├── jobs.mjs             Background job lifecycle
│   └── codex/
│       ├── discovery.mjs    Codex binary detection
│       ├── app-server.mjs   JSON-RPC 2.0 client for codex app-server
│       ├── task.mjs         Task execution with streaming (replaces callCodexCompanion)
│       ├── review.mjs       Adversarial code review via review/start
│       └── image.mjs        Image gen/edit via codex exec --full-auto
├── agents/takeover.md       Subagent: context gathering + handoff
├── commands/
│   ├── continue.md          /takeover:continue (--review, --image, --image-edit)
│   ├── models.md            /takeover:models
│   └── summary.md           /takeover:summary
├── prompts/
│   ├── task.md              System prompt for task handoffs
│   └── review.md            Adversarial review system prompt
├── skills/
│   ├── takeover-result/     Result handling: return verbatim
│   └── codex-image-result/  Image output: present SAVED: paths
├── tests/
│   ├── lib.test.mjs         Provider config, model resolution, API, retry
│   ├── mcp-server.test.mjs  TOOLS schema, JSON-RPC, validation
│   ├── discovery.test.mjs   Codex binary discovery
│   ├── app-server.test.mjs  JSON-RPC client
│   ├── image.test.mjs       Image gen/edit
│   └── jobs.test.mjs        Job lifecycle
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

`loadProviderConfig()` returns `{ native: true, provider: "claude"|"codex" }` for built-in, or `{ native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku }` for API providers.

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout. Exposes three tools:

| Tool | Input | Routes to |
|---|---|---|
| `call_model` | `provider`, `userPrompt`, `model?`, `mode?`, `write?`, `systemPrompt?` | `callAnthropicAPI` / `callCodexCompanion` (task) / `runCodexReview` / `generateImage` / `editImage` / `callNativeClaude` |
| `list_models` | (none) | `listModels()` |
| `codex_status` | `codexPath?` | `checkCodexStatus()` |

Mode routing for `call_model`:
- `mode=task` (default, any provider) → codex: `callCodexCompanion()`; native claude: `callNativeClaude()`; API: `callAnthropicAPI()`
- `mode=agent` (any provider) → codex: `callCodexCompanion()`; others: `callAgentMode()` (spawns `claude -p` with provider env)
- `mode=review` → `runCodexReview()` (codex only, adversarial)
- `mode=image-generate` → `generateImage()` (codex only)
- `mode=image-edit` → `editImage()` (codex only)

Exported for testing: `TOOLS`, `handleToolCall`, `handleCallModel`, `send`.

## Testing

```shell
node --test cc-market/takeover/tests/*.test.mjs
```

Pre-commit hook runs all takeover tests via glob. `callAnthropicAPI` tests mock `globalThis.fetch`.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic. Export functions for testability where needed.
- Version bumping is automatic — the repo-level `pre-push` hook bumps this plugin's `plugin.json` whenever `takeover/` changed in the push.
