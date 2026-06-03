# cc-market — AGENTS.md

<!--
  Boundary: This file covers cc-market plugin development ONLY.
  For repo-level config sync, see ../AGENTS.md.
  Do NOT mix config-sync details here.
-->

Community marketplace of Claude Code plugins. Each plugin lives in its own directory with independent CLAUDE.md, AGENTS.md, and `.claude/rules/`.

## Plugins

| Plugin | Directory | Description |
|---|---|---|
| [`takeover`](takeover/README.md) | `takeover/` | Multi-model AI orchestration via MCP |
| [`rem`](rem/README.md) | `rem/` | Memory management: pruning, summarization, compaction, eviction |

Each plugin has its own `AGENTS.md` and `.claude/rules/invariants.md` for progressive disclosure. See plugin READMEs for user-facing docs.

## Tests & Git Hooks

Pre-commit hook (`.git/hooks/pre-commit`) runs all plugin tests before each commit:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs
```

| Test file | Tests | Coverage |
|---|---|---|
| `takeover/tests/lib.test.mjs` | 27 | provider config, model resolution, API, retry |
| `takeover/tests/mcp-server.test.mjs` | 10 | TOOLS schema, JSON-RPC, validation |
| `rem/tests/lib.test.mjs` | 55 | frontmatter, index, date, path, state |
| `rem/tests/rem-hook.test.mjs` | 32 | isFreshSession, hasSubstantiveWork, decideStop |

Total: 124 tests. Hook blocks commit on failure. Use Node's built-in test runner (`node:test` + `node:assert/strict`).

## Adding a Plugin

1. Create `<plugin-name>/` with `.claude-plugin/plugin.json`
2. Add `AGENTS.md`, `CLAUDE.md`, and `.claude/rules/` for progressive disclosure
3. Add `README.md` for user-facing install/usage docs
4. Add `scripts/bump-version.sh` for auto-versioning
5. Add tests in `<plugin-name>/tests/` using `node:test`
6. Add entry to `.claude-plugin/marketplace.json`
7. Update this file's plugin table

## Standard

- Keep plugin concerns in `cc-market/` — never add plugin details to root `AGENTS.md`
- After plugin changes, update the plugin's own `AGENTS.md` and `README.md`
- Always add tests for new plugin logic
- Pre-commit hook catches regressions across all plugins
