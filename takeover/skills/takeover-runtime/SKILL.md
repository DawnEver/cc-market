---
name: takeover-runtime
description: Internal contract for calling the takeover companion script from Claude Code
---

# Takeover Runtime

## Provider Configuration

Providers are configured in `~/.claude/claude_env_settings.json` under `env:<provider>` keys.

Each provider block must contain:
- `ANTHROPIC_BASE_URL` — Anthropic-compatible API endpoint
- `ANTHROPIC_AUTH_TOKEN` — API key
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — default model (optional; required if not passing `--model`)

> **Security note**: `~/.claude/claude_env_settings.json` contains API keys in plaintext. Restrict permissions (`chmod 600`) and avoid syncing it through cloud folders.

## Providers

### Anthropic-compatible (deepseek, etc.)
Reads `~/.claude/claude_env_settings.json` under `env:<provider>`. Requires `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

### `claude`
Native Claude CLI via OAuth/Pro subscription. No config entry needed — bypass is automatic.

### `codex`
Delegates to the codex plugin's `codex-companion.mjs` runtime. Auto-discovered from `~/.claude/plugins/cache/openai-codex/codex/<version>/`, or override with `TAKEOVER_CODEX_COMPANION`.

- Requires the codex plugin to be installed and authenticated (`/codex:setup`, `codex login`)
- Model override: `--model <name>` (e.g. `o3`, `o4-mini`)
- Write mode: `--write` supported for codex only; rejected for all other providers

## Companion Script

The companion script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs`.

Prompt must always be passed via stdin (heredoc), never on the command line:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task --provider <name> [--model <m>] [--write] <<'PROMPT'
<prompt text>
PROMPT
```

### Subcommands

- `task` — Hand off a task; supports `--write` for codex provider only
- `plan` — Hand off a planning request; `--write` is rejected

### Behavior

- Reads provider config from `~/.claude/claude_env_settings.json`
- Calls the configured API (or delegates to codex-companion)
- Returns only the response text (stdout), diagnostics go to stderr
- Default model is the provider's `ANTHROPIC_DEFAULT_SONNET_MODEL`
