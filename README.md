# cc-market

A community marketplace of Claude Code plugins.

## Add this marketplace

```shell
/plugin marketplace add DawnEver/cc-market
```

## Available plugins

| Plugin | Description |
|---|---|
| `takeover` | Multi-model AI orchestration — delegate tasks and planning to DeepSeek, OpenAI, or any Anthropic-compatible provider |

## Install a plugin

```shell
/plugin install takeover@cc-market
```

Then use it:

```shell
/takeover:continue review this PR for security issues
/takeover:plan implement OAuth2 login
```

## Development

After cloning, run setup to enable git hooks (auto-versioning on push):

```shell
bash scripts/setup.sh
```

This configures `core.hooksPath` to `scripts/git-hooks/`, which includes a pre-push hook that auto-bumps plugin versions.

## Contributing

Each plugin lives in its own directory at the repo root. To add a plugin:

1. Create `<plugin-name>/` with a `.claude-plugin/plugin.json` manifest
2. Add a `scripts/bump-version.sh` for auto-versioning (see `takeover/scripts/bump-version.sh` for template)
3. Add an entry to `.claude-plugin/marketplace.json`
4. Open a PR

See [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) for the plugin format.
