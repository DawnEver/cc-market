# Provider Config Shape

Providers other than `claude`/`codex` are configured in `~/.claude/claude_env_settings.json`
(overridable via `TAKEOVER_CONFIG_PATH`):

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

`loadProviderConfig()` returns `{ native: true, provider: "claude"|"codex" }` for built-in
providers, or `{ native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku }`
for API providers.

If `call_model` errors with a config-related message, check that the `env:<provider>` block
exists and has the required keys above.
