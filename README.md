# cc-market

A community marketplace of plugins for **both Claude Code and Codex**.

Plugins are authored once against the Claude Code format (the source of truth) and the Codex
artifacts (`.codex-plugin/plugin.json` per plugin + `.agents/plugins/marketplace.json`) are
generated from them by `scripts/gen-codex.mjs`. Hooks and skills stay shared across both hosts;
MCP plugins keep their Claude Code `.mcp.json` source and get a generated
`.codex-plugin/mcp.json` with plugin-local relative paths for Codex. See the
[codex-support design memo](.claude/memory/2026/06/21/codex-support.md) for the design and the
validated host-compatibility contract.

> Active development: backward compatibility is not guaranteed. Plugin configs, data formats, and internal APIs may change between versions without migration paths.

## Plugins & Host Support

Most plugins run on **both** hosts. What each does and where it runs:

<!-- plugin list: keep in sync with the AGENTS.md plugin table -->

| Plugin | What it gives you | Claude Code | Codex |
|---|---|---|---|
| [`takeover`](takeover/README.md) | Delegate tasks and planning to DeepSeek, OpenAI, or any Anthropic-compatible provider | yes | yes |
| [`rem`](rem/README.md) | Memory pruning, session summarization, crystallization, automatic eviction | yes | yes (SessionStart hook injects `.claude/rules`) |
| [`sharp-review`](sharp-review/README.md) | Post-feature sharp review: 3 parallel reviewers, task sync | yes | yes |
| [`evolve`](evolve/README.md) | Iterative review→fix loop (depends on `sharp-review` + `rem`) | yes | yes |
| [`watch`](watch/README.md) | Unattended server & task supervision: health checks, anomaly detection, auto-repair | yes | yes (no `Notification` event; alert degrades to `Stop`-only) |
| [`traceme`](traceme/README.md) | Personal observability: token/cost reports, multi-device encrypted sync | yes | **no** (reads Claude transcript JSONL only) |
| [`fabric`](fabric/README.md) | Spawn & observe isolated child agent sessions of any provider | yes | yes |

**What Codex consumes:** skills, hooks, and `mcpServers`, but **not** plugin slash-commands
(those are Claude Code-only; the underlying capability is still reachable via the plugin's
skills/MCP). Codex also does not support the `Notification` or `SessionEnd` hook events, and
does not auto-load `.claude/rules` (the `rem` plugin injects them via a SessionStart hook).

## Add this marketplace

**Claude Code:**

```shell
/plugin marketplace add DawnEver/cc-market
```

**Codex** (point at a local clone of this repo; regenerate artifacts first if needed):

```shell
node scripts/gen-codex.mjs .          # refresh .codex-plugin/ + .agents/plugins/
codex plugin marketplace add <path-to-cc-market>
codex plugin add takeover@cc-market   # then rem / sharp-review / evolve / watch / fabric
```

`traceme` is Claude-only; do not `codex plugin add traceme`. See the host table above.

## Install

```shell
/plugin install takeover@cc-market
/plugin install rem@cc-market
/plugin install sharp-review@cc-market
/plugin install traceme@cc-market
/plugin install watch@cc-market
/plugin install fabric@cc-market
```

See each plugin's README for detailed usage, configuration, and API reference.

## Tests

See [AGENTS.md § Tests & Git Hooks](AGENTS.md#tests--git-hooks) for the manual test command, pre-commit scoping, and Codex e2e coverage.

## Contributing

Each plugin lives in its own directory at the repo root. See [AGENTS.md § Adding a Plugin](AGENTS.md#adding-a-plugin) for the step-by-step checklist, Codex artifact regeneration, and the automatic version-bump/tag flow, and the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) for the plugin format.
