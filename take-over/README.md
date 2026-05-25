# Take-Over — Multi-Model Orchestration

Delegate tasks and planning to external AI models from Claude Code. Configure providers in `claude_env_settings.json`, then use `/take-over:continue` or `/take-over:plan`.

## Quick Start

```bash
# In Claude Code:
/take-over:continue review this PR for security issues
/take-over:plan --provider deepseek --model deepseek-v4-pro implement OAuth2 login
```

## Commands

| Command | Description |
|---|---|
| `/take-over:continue` | Delegate investigation/debugging to another model |
| `/take-over:plan` | Generate an implementation plan from another model |

## Provider Configuration

Add model providers to `claude_env_settings.json`:

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro"
  }
}
```

Each provider needs an Anthropic-compatible Messages API endpoint.

## Adding a New Model

1. Add an `env:<provider>` block to `claude_env_settings.json`
2. Use it: `/take-over:continue --provider <provider> ...`

No plugin changes needed.

## Architecture

```
/take-over:continue --provider deepseek "review this"
  → Agent("ai-continue")
    → Bash: node ai-companion.mjs task --provider deepseek
      → Reads claude_env_settings.json env:deepseek
      → Calls DeepSeek Anthropic-compatible API
      → Returns verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/ai-companion.mjs` | Core: reads config, calls API |
| `agents/ai-continue.md` | Subagent: forwards to companion |
| `commands/continue.md` | Slash command: `/take-over:continue` |
| `commands/plan.md` | Slash command: `/take-over:plan` |
| `prompts/task.md` | System prompt for task mode |
| `prompts/plan.md` | System prompt for plan mode |
| `skills/` | Internal runtime contracts |
