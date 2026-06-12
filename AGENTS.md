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
| [`traceme`](traceme/README.md) | `traceme/` | Personal observability: token/cost reports, multi-device encrypted sync |

Each plugin has its own `AGENTS.md` and `.claude/rules/invariants.md` for progressive disclosure. Cross-plugin invariants (e.g. dev vs. runtime context boundaries) live in `cc-market/.claude/rules/invariants.md`. Runtime-relevant reference material (script flags, state schemas, file-ownership tables) lives under `skills/*/reference/`, linked from the corresponding `SKILL.md`. See plugin READMEs for user-facing docs.

## Tests & Git Hooks

Pre-commit hook (`.git/hooks/pre-commit`) runs all plugin tests before each commit:

```shell
node --test cc-market/takeover/tests/*.test.mjs cc-market/rem/tests/*.test.mjs cc-market/sharp-review/tests/*.test.mjs cc-market/traceme/tests/*.test.mjs
```

| Test file | Tests | Coverage |
|---|---|---|
| `takeover/tests/lib.test.mjs` | 27 | provider config, model resolution, API, retry |
| `takeover/tests/mcp-server.test.mjs` | 10 | TOOLS schema, JSON-RPC, validation |
| `rem/tests/frontmatter.test.mjs` | 13 | frontmatter parsing, field get/set |
| `rem/tests/date-path.test.mjs` | 16 | date formatting, path resolution, memory dir security |
| `rem/tests/lib.test.mjs` | 17 | index parsing, constants, file collection, state, findProjectRoot |
| `rem/tests/memory-state.test.mjs` | 13 | _meta.json state: load, save, bump, drop, self-heal, scope isolation |
| `rem/tests/scope-validate.test.mjs` | 6 | scope isolation check/fix, intermediate file integrity |
| `rem/tests/rem-hook.test.mjs` | 32 | isFreshSession, hasSubstantiveWork, decideStop |
| `rem/tests/migrations.test.mjs` | 9 | `migrate()`: volatile field stripping, _meta.json import, gitignore block normalization, legacy task-dir cleanup, idempotence |
| `rem/tests/task-lib.test.mjs` | 36 | scan, parse, markFinding, scanAllScopes, formatScopeReport |
| `rem/tests/check-docs.test.mjs` | 29 | collectDocs, crossReference, formatReport, CLI |
| `sharp-review/tests/lib.test.mjs` | 17 | SR-ID parsing, module/category inference, frontmatter |
| `sharp-review/tests/manifest.test.mjs` | 42 | classifyLowValue, numstat/name-status parsing, buildManifest, decideMode, renderManifestText, extractHunkHeaders |
| `sharp-review/tests/hook.test.mjs` | 4 | findGitRoot project-root resolution |
| `sharp-review/tests/migrations.test.mjs` | 4 | `migrate()`: legacy finding-file consolidation, idempotence |
| `watch/tests/` (Python) | 48 | config, daemon, components, registry |
| `traceme/tests/crypto.test.mjs` | 9 | AES-256-GCM encrypt/decrypt |
| `traceme/tests/db.test.mjs` | 10 | replaceSession, derived daily/model/tool/skill queries, billable basis, category unit-split (tokens vs bytes_est), `categorizeTool`, takeover fold-in |
| `traceme/tests/scan.test.mjs` | 5 | transcript scan: token aggregation, message-id dedup, cursor skip, idempotent re-scan, category bucketing |
| `traceme/tests/report.test.mjs` | 7 | generateReport/generateStats, merged vs local-only data source |
| `traceme/tests/dashboard.test.mjs` | 9 | buildDashboardHtml: ECharts CDN, flat fact-table payload, interactive controls incl. device dimension, cross-device data, data-honesty labels, embedded-JSON escaping |
| `traceme/tests/sync.test.mjs` | 7 | dump/import, readMergedSnapshot, readDeviceFacts, verifyConsistency |
| `traceme/tests/pricing.test.mjs` | 6 | model matching: dot/dash canonicalization, longest-prefix, aliases, fallback, calcCost |

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
- **A skill's execution knowledge goes in its `SKILL.md` / `reference/*.md`, never in `rules/*` or `AGENTS.md`/`CLAUDE.md`.** At runtime a skill sees only its own files and the host project's config — never this repo's rules/`AGENTS.md` (dev-context only — see `.claude/rules/invariants.md` "Dev context vs. runtime context").
- After plugin changes, update the plugin's own `AGENTS.md` and `README.md`
- Always add tests for new plugin logic
- Pre-commit hook catches regressions across all plugins
- Backward compatibility is not a concern here. Freely rename/restructure data formats, configs, and internal APIs instead of adding migration shims or compat layers — update all call sites and docs in the same change.
