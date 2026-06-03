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

## Install

```shell
/plugin install takeover@cc-market
/plugin install rem@cc-market
```

See each plugin's README for detailed usage, configuration, and API reference.

## Tests

All plugins share a test suite run by the pre-commit hook (`.git/hooks/pre-commit`). Run manually:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs
```

## Contributing

Each plugin lives in its own directory at the repo root. To add a plugin:

1. Create `<plugin-name>/` with a `.claude-plugin/plugin.json` manifest
2. Add a `scripts/bump-version.sh` for auto-versioning (see `takeover/scripts/bump-version.sh` for template)
3. Add a `README.md` with install, usage, and configuration docs
4. Add tests in `<plugin-name>/tests/` using Node's built-in test runner
5. Add an entry to `.claude-plugin/marketplace.json`
6. Open a PR

See [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) for the plugin format.
