---
name: takeover-runtime
description: Internal contract for calling the takeover companion script from Claude Code
---

# Takeover Runtime

## Companion Script

Location: `${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs`

Prompt must be passed via stdin (heredoc), never on the command line:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" <task|plan> --provider <name> [--model <m>] <<'PROMPT'
<prompt text>
PROMPT
```

### Subcommands

- `task` — Hand off a task/investigation
- `plan` — Hand off a planning request
- `models` — List available providers

### Providers

- **`claude`** — Native Claude CLI via OAuth/Pro subscription. No config needed.
- **`codex`** — Delegates to codex-companion.mjs. Auto-discovered from plugin cache, or override via `TAKEOVER_CODEX_COMPANION`. Supports `--model` and `--write`.
- **API-based** (e.g. deepseek) — Reads `~/.claude/claude_env_settings.json` under `env:<provider>`. Requires `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

### Config override

`TAKEOVER_CONFIG_PATH` env var overrides the default config path (`~/.claude/claude_env_settings.json`).

### Output

- Response text on stdout. Diagnostics and progress on stderr.
- Token usage reported on stderr for API-based providers.
- Returns verbatim — do not paraphrase, summarize, or add commentary.
- On failure, report the error and suggest checking provider configuration.
