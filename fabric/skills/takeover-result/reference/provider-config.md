# Provider Config Shape

The provider CATALOGUE (endpoints, models, key credential usernames) is ai-lab's
(`python -m ai_lab.providers --json`). Setup copies it into `~/.claude/provider-cache.json`,
next to `~/.claude/claude_env_settings.json` (both move together with `CC_MARKET_CONFIG_PATH`).
fabric only reads that cache: an absent cache, one older than 7 days, one of another
`schema_version`, or one whose recorded catalogue inputs changed on disk is refused as
`unsupported`, naming the remedy (`node scripts/setup/setup.js`). There is no fallback.

`claude` and `codex` are host CLIs (their own sign-in), not catalogue rows.

`claude_env_settings.json` keeps only host projection rules, per provider:

```json
{ "providers": { "<provider>": { "claudeApiKeyEnv": "ANTHROPIC_AUTH_TOKEN" } } }
```

`claudeApiKeyEnv` names the env var a `claude` child (agent mode) reads the key from, and so
the header style the observe proxy sends (`ANTHROPIC_AUTH_TOKEN` -> Bearer, else `x-api-key`).

`loadProviderConfig()` returns `{ native: true, provider }` for the host CLIs, or
`{ native: false, provider, row, baseUrl, keyEnv, tokenStyle, default<Tier> }` for a catalogue
row; `baseUrl` is the row's anthropic-protocol endpoint (null if it has none, which refuses
agent mode and observe on that provider as `unsupported`).
