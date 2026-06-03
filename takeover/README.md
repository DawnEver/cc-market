# takeover

Hand off tasks to another AI model via MCP. Routes to Claude, Codex, DeepSeek, or any Anthropic-compatible API.

## Install

```shell
/plugin install takeover@cc-market
```

Then register the MCP server in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "takeover": {
      "command": "node",
      "args": ["<plugin-root>/scripts/mcp-server.mjs"]
    }
  }
}
```

## Usage

```shell
/takeover:continue review this PR for security issues
/takeover:plan implement OAuth2 login
/takeover:continue --provider deepseek --model deepseek-v4-pro explain this crash
/takeover:models
```

## Commands

| Command | Description |
|---|---|
| `/takeover:continue` | Hand off a task or investigation to another model |
| `/takeover:plan` | Hand off a planning request to another model |
| `/takeover:models` | List all available providers and their models |

## Configuration

Create `~/.claude/claude_env_settings.json` with your provider blocks.

**Foundry mode** (recommended for DeepSeek):

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

**Direct mode**:

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash"
  }
}
```

> **Security**: `chmod 600 ~/.claude/claude_env_settings.json` and avoid syncing through cloud storage.

**Built-in providers** (no config needed):
- `claude` — native Claude CLI via your Pro subscription
- `codex` — OpenAI Codex via the codex plugin (requires `/codex:setup`)

## How It Works

```
/takeover:continue --provider deepseek "review this"
  → Agent(takeover:takeover)
    → MCP tool: call_model(provider=deepseek, mode=task, userPrompt="review this")
      → mcp-server.mjs reads ~/.claude/claude_env_settings.json
      → Calls DeepSeek Anthropic-compatible API
      → Returns output verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/mcp-server.mjs` | MCP server: call_model + list_models tools |
| `scripts/lib.mjs` | Core: provider config, API callers, retry |
| `agents/takeover.md` | Subagent: thin handoff wrapper |
| `commands/continue.md` | `/takeover:continue` |
| `commands/plan.md` | `/takeover:plan` |
| `commands/models.md` | `/takeover:models` |
| `prompts/task.md` | System prompt for task handoffs |
| `prompts/plan.md` | System prompt for plan handoffs |
| `skills/takeover-result/` | Result handling contract |
