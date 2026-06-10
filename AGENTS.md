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
| [`sharp-review`](sharp-review/README.md) | `sharp-review/` | Post-feature sharp review: 3 parallel reviewers, task sync, memory cross-reference |
| [`watch`](watch/README.md) | `watch/` | Unattended server & task supervision: health checks, anomaly detection, auto-repair |

Each plugin has its own `AGENTS.md` and `.claude/rules/invariants.md` for progressive disclosure. Runtime-relevant reference material (script flags, state schemas, file-ownership tables) lives under `skills/*/reference/`, linked from the corresponding `SKILL.md`. See plugin READMEs for user-facing docs.

## Tests & Git Hooks

Pre-commit hook (`.git/hooks/pre-commit`) runs all plugin tests before each commit:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs cc-market/sharp-review/tests/*.test.mjs
```

| Test file | Tests | Coverage |
|---|---|---|
| `takeover/tests/lib.test.mjs` | 27 | provider config, model resolution, API, retry |
| `takeover/tests/mcp-server.test.mjs` | 10 | TOOLS schema, JSON-RPC, validation |
| `rem/tests/frontmatter.test.mjs` | 26 | frontmatter parsing, field get/set, tier, stamping |
| `rem/tests/date-path.test.mjs` | 16 | date formatting, path resolution, memory dir security |
| `rem/tests/lib.test.mjs` | 20 | index parsing, constants, file collection, state, findProjectRoot |
| `rem/tests/rem-hook.test.mjs` | 32 | isFreshSession, hasSubstantiveWork, decideStop |
| `rem/tests/migrations.test.mjs` | 5 | `migrate()`: legacy tasks dir cleanup, memory stamping, idempotence |
| `sharp-review/tests/lib.test.mjs` | 19 | SR-ID parsing, module/category inference, frontmatter |
| `sharp-review/tests/hook.test.mjs` | 4 | findGitRoot project-root resolution |
| `sharp-review/tests/migrations.test.mjs` | 4 | `migrate()`: legacy finding-file consolidation, idempotence |
| `watch/tests/` (Python) | 48 | config, daemon, components, registry |

All JS tests (`*.test.mjs`) run via pre-commit hook. Use Node's built-in test runner (`node:test` + `node:assert/strict`). Python tests: `python -m unittest discover watch/tests/`.

## Migrating `.claude/` Project Files

Backward compatibility for `.claude/` data formats is not a concern (see Standard below) — but when a breaking format change ships, existing projects need a path to the new format. Each plugin owns this via an optional `migrations/migrate.mjs`:

```js
// <plugin>/migrations/migrate.mjs
export async function migrate(projectRoot) {
  // idempotent: detect old-format artifacts under projectRoot/.claude and fix them.
  // No-op (changed: false) if already current. Safe to re-run.
  return { changed: false, summary: [] };
}
```

The root repo's `node scripts/setup/migrate.js` (`npm run migrate`) discovers every `<plugin>@cc-market` entry relevant to the current project (via `~/.claude/plugins/installed_plugins.json`) and calls `migrate(projectRoot)` if `migrations/migrate.mjs` exists. "Migrate to latest only" — no version-range bookkeeping; each migration is self-detecting and additive (fold new format changes into the same file rather than chaining versioned steps). Plugins with nothing to migrate simply omit `migrations/`.

## Adding a Plugin

1. Create `<plugin-name>/` with `.claude-plugin/plugin.json` (include a `"version"` field)
2. Add `AGENTS.md`, `CLAUDE.md`, and `.claude/rules/` for progressive disclosure
3. Add `README.md` for user-facing install/usage docs
4. Add tests in `<plugin-name>/tests/` using `node:test`
5. Add entry to `.claude-plugin/marketplace.json`
6. Update this file's plugin table

Versioning is automatic: the `pre-push` hook (`scripts/git-hooks/pre-push`, wired via `core.hooksPath`) bumps the patch version of **every changed plugin's** `plugin.json` plus the marketplace manifest on each push, then amends the commit and tags the release. No per-plugin bump script needed.

## Standard

- Keep plugin concerns in `cc-market/` — never add plugin details to root `AGENTS.md`
- After plugin changes, update the plugin's own `AGENTS.md` and `README.md`
- Always add tests for new plugin logic
- Pre-commit hook catches regressions across all plugins
- Backward compatibility is not a concern here. Freely rename/restructure data formats, configs, and internal APIs instead of adding migration shims or compat layers — update all call sites and docs in the same change.
