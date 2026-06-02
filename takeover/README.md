# takeover

Hand off tasks to another AI model and get back the result. Let a different model take over any task, investigation, or planning request — then return to Claude with the output.

## Install

```shell
/plugin install takeover@cc-market
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

**Foundry mode** (recommended for DeepSeek — uses Anthropic-compatible endpoint directly):

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

**Direct mode** (legacy, proxy-based):

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash"
  }
}
```

When `CLAUDE_CODE_USE_FOUNDRY` is `"1"`, the companion reads `ANTHROPIC_FOUNDRY_BASE_URL` and `ANTHROPIC_FOUNDRY_API_KEY`. Otherwise it reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. Either way, `ANTHROPIC_DEFAULT_SONNET_MODEL` is required if you don't pass `--model`.

> **Security**: `claude_env_settings.json` stores API keys in plaintext. Run `chmod 600 ~/.claude/claude_env_settings.json` and avoid syncing this file through cloud storage.

**Built-in providers** (no config needed):
- `claude` — native Claude CLI via your Pro subscription
- `codex` — OpenAI Codex via the codex plugin (requires `/codex:setup`)

## Adding a Provider

1. Add an `env:<provider>` block to `~/.claude/claude_env_settings.json`
2. Use it: `/takeover:continue --provider <provider> ...`

## How It Works

```
/takeover:continue --provider deepseek "review this"
  → Agent(takeover:takeover)
    → Bash: node companion.mjs task --provider deepseek
      → Reads ~/.claude/claude_env_settings.json env:deepseek
      → Calls DeepSeek Anthropic-compatible API
      → Returns output verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/companion.mjs` | Core: reads config, calls API |
| `agents/takeover.md` | Subagent: thin handoff wrapper |
| `commands/continue.md` | `/takeover:continue` |
| `commands/plan.md` | `/takeover:plan` |
| `commands/models.md` | `/takeover:models` |
| `prompts/task.md` | System prompt for task handoffs |
| `prompts/plan.md` | System prompt for plan handoffs |
| `skills/takeover-runtime/` | Runtime contract |
| `skills/takeover-result/` | Result handling contract |
