---
name: ismain-two-argument-spellings
description: shared/lib.mjs isMain realpaths both sides and accepts either argument form; the eight inline copies are gone and the bundler now matches the integrity test
metadata:
  type: project
  created: 2026-09-20
---

# `isMain`: realpath both sides, and accept either argument

`shared/lib.mjs`'s `isMain` compared `fileURLToPath(importMeta.url)` against `process.argv[1]`
with only backslash normalisation — the bug class described in the config repo's
`entry-guard-symlink-class` memory. Node realpaths a module but not `argv[1]`, so anything
reached through a symlink or junction compared unequal, its body never ran, and the process
exited 0 having done nothing.

**Latent here, not live:** plugin hooks are launched from the real cache path
(`CLAUDE_PLUGIN_ROOT`), so nothing was broken. It bites when a plugin script is run from a
symlinked checkout, a synced workspace, or a relocated install. Evidence it has bitten before:
`evolve/scripts/evolve.mjs` carried an `|| process.argv[1]?.endsWith('evolve.mjs')` escape hatch,
which only makes sense if the strict comparison was failing.

## The trap worth closing: two argument spellings

This repo's helper took the **meta object** (`isMain(import.meta)`); the config repo's
`is-main.mjs` takes a **url string** (`isMain(import.meta.url)`). Adopting the config repo's
spelling at the eight new call sites failed **18 tests** — because `importMeta.url` on a string
is `undefined`, so the guard returned `false` for every entry point.

`isMain` now normalises: `typeof importMeta === 'string' ? importMeta : importMeta?.url`. That
removes the trap rather than requiring everyone to remember which repo uses which spelling.

## Eight inline copies replaced

`fabric/web/server.mjs`, `cc-latex/scripts/word-count.mjs`, `evolve/scripts/evolve.mjs`,
`scripts/gen-codex.mjs`, `fabric/scripts/mcp-server.mjs`, and
`rem/scripts/{recall,memo,inject-rules}`. The `fileURLToPath` imports they no longer needed went
with them.

## Bundled copies

`shared/lib.mjs` is copied into each plugin that imports it (8 copies). After changing the
canonical file, re-propagate — `scripts/git-hooks/pre-push` does it on push, or copy directly.
`shared/tests/lib.test.mjs` **asserted the broken behaviour as correct**; it now covers the
symlink case (the whole point), an unreadable entry path, and both argument spellings.

## Same session: the bundler and the integrity test now agree

`pre-push` copied `shared/` into *every* plugin with a `plugin.json`, while
`tests/bundle-integrity.test.mjs` verified only plugins whose code imports it (`usesShared()`).
`cc-academia` sat in the gap with 12 unimported `.mjs` files that nothing checked. Both sides now
use one criterion (`uses_shared()` in the hook, `usesShared()` in the test), the hook removes a
stale copy when it finds one, and a new assertion fails if they drift apart again.

Note the correction: `cc-latex` was reported as also carrying dead copies and does not — it
imports `shared/` like the other six.

Related (config repo): `entry-guard-symlink-class`, `doctor-invariants`
