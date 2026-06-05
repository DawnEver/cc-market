# cc-market

A community marketplace of Claude Code plugins.

## Add this marketplace

```shell
/plugin marketplace add DawnEver/cc-market
```

## Available plugins

| Plugin | Description |
|---|---|
| [`takeover`](takeover/README.md) | Multi-model AI orchestration — delegate tasks and planning to DeepSeek, OpenAI, or any Anthropic-compatible provider |
| [`rem`](rem/README.md) | REM sleep for Claude sessions — memory pruning, session summarization, compaction, and automatic eviction |
| [`sharp-review`](sharp-review/README.md) | Post-feature sharp review — 3 parallel reviewers, task sync, rem-integrated memory lifecycle |

## Install

```shell
/plugin install takeover@cc-market
/plugin install rem@cc-market
/plugin install sharp-review@cc-market
```

See each plugin's README for detailed usage, configuration, and API reference.

## Tests

All plugins share a test suite run by the pre-commit hook (`.git/hooks/pre-commit`). Run manually:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs cc-market/sharp-review/tests/*.test.mjs
```

## Contributing

Each plugin lives in its own directory at the repo root. To add a plugin:

1. Create `<plugin-name>/` with a `.claude-plugin/plugin.json` manifest (include a `"version"` field)
2. Add a `README.md` with install, usage, and configuration docs
3. Add tests in `<plugin-name>/tests/` using Node's built-in test runner
4. Add an entry to `.claude-plugin/marketplace.json`

Versioning is automatic — the `pre-push` hook bumps every changed plugin's `plugin.json` patch version plus the marketplace manifest, then tags the release.
6. Open a PR

See [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) for the plugin format.
