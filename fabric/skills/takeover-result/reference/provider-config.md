# Provider Config Shape

Providers other than `claude`/`codex` are configured in `~/.claude/claude_env_settings.json`
(overridable via `TAKEOVER_CONFIG_PATH` / `CC_MARKET_CONFIG_PATH`). The shared file syncs
across machines (OneDrive), so it must NOT carry secrets — each machine keeps its own keys
in `~/.claude/claude_env_settings.local.json`, which `readRegistry()` deep-merges over the
shared file (override wins). Shared file keeps base URLs / model pins:

```json
{
  "env:deepseek": {
    "CLAUDE_CODE_USE_FOUNDRY": "1",
    "ANTHROPIC_FOUNDRY_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash"
  }
}
```

Local file supplies the key (created on each machine by `setup.js` from the repo's
`claude_env_settings.local.template.json`):

```json
{
  "env:deepseek": { "ANTHROPIC_FOUNDRY_API_KEY": "sk-..." }
}
```

`loadProviderConfig()` returns `{ native: true, provider: "claude"|"codex" }` for built-in
providers, or `{ native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku }`
for API providers.

If `call` errors with a config-related message, check that the `env:<provider>` block
exists and has the required keys above — a machine without a local key fails with
"missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY", the intended per-host failure mode.
