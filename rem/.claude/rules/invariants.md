# REM Invariants

Always-injected behavioral constraints for working on the rem plugin.

## The tree is the only source of truth

Reading memory never writes: no hook, recall or report records an access, and no per-entry
state exists beside the files. An entry leaves ONLY when a live entry names it in
`merged_from:` (supersede, `merge-memory.js`, `crystallize.js` ledger); `retireMemory()` /
`retire-memory.js` is the one deleter. Never correct an old entry in place — write a successor
that names it. `scope-split.js` moves files between scopes (a rename, not a retirement).

## Hook pending-work gate

`rem-hook.js` gates Stop-hook state advancement on `hasPendingWork` (background tasks or
`taskActiveUntil`). Do not bypass or weaken this gate — it prevents mid-flight interruption of
multi-round skills. The runtime `taskActiveUntil` procedure is documented in
`skills/rem/SKILL.md` and `skills/rem/reference/state-schema.md`.

## Path format → `skills/rem/reference/memory-conventions.md`

Do not read, write, or accept old flat-date `YYYY-MM-DD/slug.md` paths anywhere — only
nested `YYYY/MM/DD/slug.md`. The format spec and migration rules live in
`skills/rem/reference/memory-conventions.md`.

## Path security

Use `resolveMemoryPath()` + `isInsideMemoryDir()` before any file I/O on paths that could
come from user input or index entries.

```js
const file = resolveMemoryPath(relPath);
if (!isInsideMemoryDir(file)) throw new Error("path traversal denied");
```

## Frontmatter → `skills/rem/reference/memory-conventions.md`

Content fields (`name`, `description`, `metadata.type`, optional `merged_from`) live in file YAML
frontmatter. There is no volatile metadata anywhere. Full schema is in
`skills/rem/reference/memory-conventions.md`.

## Index → `skills/rem/reference/memory-conventions.md`

`MEMORY.md` is derived, gitignored, and written only through `rebuildIndex()` (a pure function
of the tree, written only when its bytes change — no lock, no hand edits). Its line format is
`formatIndexEntry()` in `lib.mjs`.

## Scope isolation

Scopes are discovered purely by filesystem: any directory with `.claude/memory/` is a scope.
`findAllScopes()` discovers all scopes (max depth 4), `isScopeIgnored()` skips directories
matching `scopes.ignore` patterns. Each scope owns its own memory tree and derived `MEMORY.md`.

## State

Unified hook state in `.claude/.rem-state.json`. Use `loadState()`/`saveState()`/`withStateLock()` —
never read/write directly. Every save is tmp+rename with a unique temp name
(`shared/atomic-write.mjs`), so a reader never sees a torn file.

### deepMerge preserves foreign keys

`deepMerge` must preserve keys in `partial` that are not in `DEFAULT_STATE`. Other plugins
(e.g. sharp-review) store their state under the same file — silent drop on load→save would
lose their data. When adding a new key to `DEFAULT_STATE`, add it here first, then propagate
to all `*/shared/state.mjs` copies. Bundle integrity test enforces per-plugin copies stay in
sync with `cc-market/shared/`.

## Tests

Tests across files in `rem/tests/*.test.mjs`. Run all: `node --test cc-market/rem/tests/*.test.mjs`. Pre-commit hook enforces.
