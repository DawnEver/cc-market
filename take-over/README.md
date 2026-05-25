# take-over

Hand off tasks to another AI model and get back the result. Let a different model take over any task, investigation, or planning request — then return to Claude with the output.

## Install

```shell
/plugin install take-over@cc-market
```

## Usage

```shell
/take-over:continue review this PR for security issues
/take-over:plan implement OAuth2 login
/take-over:continue --provider deepseek --model deepseek-v4-pro explain this crash
```

## Commands

| Command | Description |
|---|---|
| `/take-over:continue` | Hand off a task or investigation to another model |
| `/take-over:plan` | Hand off a planning request to another model |

## Configuration

Create `~/.claude/take-over.json` with your provider blocks:

```json
{
  "env:deepseek": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro"
  },
  "env:claude": {}
}
```

Each provider needs an Anthropic-compatible Messages API endpoint. Set `TAKE_OVER_CONFIG` to use a different config file path.

**Built-in providers** (no config needed):
- `claude` — native Claude CLI via your Pro subscription
- `codex` — OpenAI Codex via the codex plugin (requires `/codex:setup`)

## Adding a Provider

1. Add an `env:<provider>` block to `~/.claude/take-over.json`
2. Use it: `/take-over:continue --provider <provider> ...`

## How It Works

```
/take-over:continue --provider deepseek "review this"
  → Agent(take-over:take-over)
    → Bash: node companion.mjs task --provider deepseek
      → Reads ~/.claude/take-over.json env:deepseek
      → Calls DeepSeek Anthropic-compatible API
      → Returns output verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/companion.mjs` | Core: reads config, calls API |
| `agents/take-over.md` | Subagent: thin handoff wrapper |
| `commands/continue.md` | `/take-over:continue` |
| `commands/plan.md` | `/take-over:plan` |
| `prompts/task.md` | System prompt for task handoffs |
| `prompts/plan.md` | System prompt for plan handoffs |
| `skills/take-over-runtime/` | Runtime contract |
| `skills/take-over-result/` | Result handling contract |
