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

Create `~/.claude/claude_env_settings.json` with your provider blocks:

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash"
  }
}
```

Each provider needs `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and optionally `ANTHROPIC_DEFAULT_SONNET_MODEL` (required if you don't pass `--model`).

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
