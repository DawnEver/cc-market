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

> **On Codex:** install with `codex plugin add takeover@cc-market`. Codex consumes the MCP
> server (the `call_model` / `list_models` / `codex_status` tools) but **not** the
> `/takeover:*` slash-commands — call the MCP tools directly, or ask Codex to use them.

## Usage

```shell
/takeover:continue review this PR for security issues
/takeover:summary
/takeover:continue --provider deepseek --model deepseek-v4-pro explain this crash
/takeover:models

# Codex-specific (requires codex CLI installed)
/takeover:continue --provider codex --review
/takeover:continue --provider codex --image "a sunset over mountains"
/takeover:continue --provider codex --image-edit photo.png "make it brighter"
```

## Commands

| Command | Description |
|---|---|
| `/takeover:continue` | Hand off a task to another model. Supports `--review`, `--image`, `--image-edit` with `--provider codex`. |
| `/takeover:summary` | Summarize the current conversation |
| `/takeover:models` | List all available providers and their models |

### Mode Flags (--provider codex only)

| Flag | Mode | Description |
|---|---|---|
| (default) | `task` | Code investigation, debugging, refactoring |
| `--review` | `review` | Adversarial code review (default stance: skepticism) |
| `--image` | `image-generate` | Generate images via Codex's built-in imagegen skill |
| `--image-edit` | `image-edit` | Edit an existing image via Codex |

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
- `codex` — OpenAI Codex via direct app-server integration (requires `codex` CLI installed and authenticated)

## How It Works

```
/takeover:continue --provider deepseek "review this"
  → Agent(takeover:takeover)
    → MCP tool: call_model(provider=deepseek, mode=task, userPrompt="review this")
      → mcp-server.mjs reads ~/.claude/claude_env_settings.json
      → Calls DeepSeek Anthropic-compatible API
      → Returns output verbatim

/takeover:continue --provider codex --review
  → Agent gathers git diff
    → MCP tool: call_model(provider=codex, mode=review, userPrompt="<diff>")
      → CodexAppServerClient → codex app-server → review/start
      → Returns findings verbatim
```

## Files

| Path | Purpose |
|---|---|
| `scripts/mcp-server.mjs` | MCP server: call_model, list_models, codex_status tools |
| `scripts/lib.mjs` | Core: provider config, API callers, retry, flag parsing |
| `scripts/codex/discovery.mjs` | Codex binary detection |
| `scripts/codex/app-server.mjs` | JSON-RPC 2.0 client for codex app-server |
| `scripts/codex/task.mjs` | Task execution with streaming |
| `scripts/codex/review.mjs` | Adversarial code review |
| `scripts/codex/image.mjs` | Image generation and editing |
| `agents/takeover.md` | Subagent: context gathering + handoff |
| `commands/continue.md` | `/takeover:continue` |
| `commands/models.md` | `/takeover:models` |
| `commands/summary.md` | `/takeover:summary` |
| `prompts/task.md` | System prompt for task handoffs |
| `prompts/review.md` | Adversarial review system prompt |
| `skills/takeover-result/` | Result handling contract |
| `skills/codex-image-result/` | Image output handling |
| `tests/` | Test suite (lib, mcp-server, discovery, app-server, task, review, image) |

## Tests

```shell
node --test cc-market/takeover/tests/lib.test.mjs
node --test cc-market/takeover/tests/mcp-server.test.mjs
```

A pre-commit hook in the cc-market repo runs all plugin tests before every commit.

## Acknowledgments

The Codex integration draws inspiration from:

- **[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)** — JSON-RPC
  app-server communication, streaming notifications, adversarial review stance.
- **[KingGyuSuh/codex-image-in-cc](https://github.com/KingGyuSuh/codex-image-in-cc)** —
  The `codex exec --full-auto` delegation pattern for image generation and editing.

No code was copied — only architectural patterns were referenced.
