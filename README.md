# cc-market

A community marketplace of plugins for **both Claude Code and Codex**.

Plugins are authored once against the Claude Code format (the source of truth) and the Codex
artifacts (`.codex-plugin/plugin.json` per plugin + `.agents/plugins/marketplace.json`) are
generated from them by `scripts/gen-codex.mjs`. Codex ingests Claude plugins natively —
it auto-discovers `hooks.json`/`.mcp.json`/`skills/` and substitutes `${CLAUDE_PLUGIN_ROOT}` —
so the same plugin runs on either host. See the [codex-support design memo](.claude/memory/2026/06/21/codex-support.md)
for the design and the validated host-compatibility contract.

> Active development — backward compatibility is not guaranteed. Plugin configs, data formats, and internal APIs may change between versions without migration paths.

## Add this marketplace

**Claude Code:**

```shell
/plugin marketplace add DawnEver/cc-market
```

**Codex** (point at a local clone of this repo; regenerate artifacts first if needed):

```shell
node scripts/gen-codex.mjs .          # refresh .codex-plugin/ + .agents/plugins/
codex plugin marketplace add <path-to-cc-market>
codex plugin add takeover@cc-market
```

## Available plugins

| Plugin | Description |
|---|---|
| [`takeover`](takeover/README.md) | Multi-model AI orchestration — delegate tasks and planning to DeepSeek, OpenAI, or any Anthropic-compatible provider |
| [`rem`](rem/README.md) | REM sleep for Claude sessions — memory pruning, session summarization, compaction, and automatic eviction |
| [`sharp-review`](sharp-review/README.md) | Post-feature sharp review — 3 parallel reviewers, task sync, rem-integrated memory lifecycle |
| [`traceme`](traceme/README.md) | Personal observability — token/cost reports, tool usage stats, multi-device encrypted sync |
| [`watch`](watch/README.md) | Unattended server & task supervision — health checks, anomaly detection, auto-repair |

## Install

```shell
/plugin install takeover@cc-market
/plugin install rem@cc-market
/plugin install sharp-review@cc-market
/plugin install traceme@cc-market
/plugin install watch@cc-market
```

See each plugin's README for detailed usage, configuration, and API reference.

## Tests

All plugins share a test suite run by the pre-commit hook (`.git/hooks/pre-commit`). Run manually:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs cc-market/sharp-review/tests/*.test.mjs cc-market/evolve/tests/*.test.mjs cc-market/traceme/tests/*.test.mjs cc-market/tests/gen-codex.test.mjs
```

Codex host integration is exercised end-to-end (in an isolated `CODEX_HOME`, requires the
`codex` CLI) by `scripts/codex-e2e.sh` — it validates every generated `.codex-plugin/plugin.json`,
adds the marketplace, and installs a plugin.

## Contributing

Each plugin lives in its own directory at the repo root. To add a plugin:

1. Create `<plugin-name>/` with a `.claude-plugin/plugin.json` manifest (include a `"version"` field)
2. Add a `README.md` with install, usage, and configuration docs
3. Add tests in `<plugin-name>/tests/` using Node's built-in test runner
4. Add an entry to `.claude-plugin/marketplace.json`
5. Run `node scripts/gen-codex.mjs .` to regenerate the Codex artifacts (don't hand-edit
   `.codex-plugin/` or `.agents/plugins/` — they are generated). Optionally add a `codexInterface`
   block to your `plugin.json` to override the synthesized Codex `interface` fields.

Versioning is automatic — the `pre-push` hook bumps every changed plugin's `plugin.json` patch version plus the marketplace manifest, then tags the release.
6. Open a PR

See [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) for the plugin format.
