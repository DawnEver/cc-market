---
name: ai-cli-runtime
description: Internal helper contract for calling the ai-companion runtime from Claude Code
---

# AI Companion Runtime

## Provider Configuration

Providers are configured in the project's `claude_env_settings.json` under `env:<provider>` keys.

Each provider block must contain:
- `ANTHROPIC_BASE_URL` — Anthropic-compatible API endpoint
- `ANTHROPIC_AUTH_TOKEN` — API key
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — model for large tasks
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — balanced model (default)
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — fast/light model

## Providers

### Anthropic-compatible (deepseek, etc.)
Reads `claude_env_settings.json` under `env:<provider>`. Requires `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

### `claude`
Native Claude CLI via OAuth/Pro subscription. No API key needed. Config block must be empty (`{}`).

### `codex`
Delegates to the codex plugin's `codex-companion.mjs` runtime (auto-discovered from `~/.claude/plugins/cache/openai-codex/codex/<version>/`). Does **not** call `codex exec` directly — uses the companion's `task` subcommand which goes through the App Server IPC layer.

- Requires the codex plugin to be installed and authenticated (`/codex:setup`, `codex login`)
- Model override: `--model <name>` (e.g. `o3`, `o4-mini`)
- Write mode: `--write` (passes `--write` to codex-companion)
- Background jobs for codex: managed via `/codex:status`, `/codex:result`, `/codex:cancel` — not via ai-companion

## Companion Script

The companion script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs`.

### Subcommands

- `task --provider <name> [--model <m>] [--write] <prompt>` — Run a task (read-only by default)
- `plan --provider <name> [--model <m>] <prompt>` — Generate an implementation plan

### Behavior

- Reads provider config from `claude_env_settings.json`
- Calls the configured Anthropic-compatible Messages API (or delegates to codex-companion for codex)
- Returns only the response text (stdout), diagnostics go to stderr
- Default model is the provider's `ANTHROPIC_DEFAULT_SONNET_MODEL`
- Read-only by default; pass `--write` to allow workspace writes
