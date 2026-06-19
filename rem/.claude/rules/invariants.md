# REM Invariants

Always-injected behavioral constraints for working on the rem plugin.

## Append-only

Memory files in `.claude/memory/` are NEVER deleted. `prune-memory.js` and `compact.js` only mark entries as dropped in `_meta.json` — files stay on disk forever.

## Path format: nested YYYY/MM/DD/ only

Memory files MUST live at `.claude/memory/YYYY/MM/DD/slug.md` — nested per-day directories.
The old flat `YYYY-MM-DD/slug.md` format is rejected by `extractDateFromPath` and must be
migrated via `migrate.mjs` (which runs `migrateFlatDirs` before `stamp-memory.js`). Do not
read, write, or accept old-format paths anywhere. `parseIndexEntry` normalizes old-format
index entries to nested form on read via `normalizeMemoryPath`.

## Path security

Use `resolveMemoryPath()` + `isInsideMemoryDir()` before any file I/O on paths that could come from user input or index entries.

```js
const file = resolveMemoryPath(relPath);
if (!isInsideMemoryDir(file)) throw new Error("path traversal denied");
```

## Frontmatter

Memory files frontmatter contains content fields ONLY: `name`, `description`, `metadata.type`.
Volatile metadata (accessed, count, tier, dropped) lives in gitignored `_meta.json` per date
directory — never in frontmatter. Full schema → `skills/rem/reference/memory-conventions.md`.

## Index

`MEMORY.md` is a generated, gitignored file — rebuilt by `rebuildIndex(scopeRoot)` on each
session start, touch, prune, and stamp. Entries sorted by `accessed` descending, max 20
(`MAX_ENTRIES`). Use `parseIndex()` and `formatIndexEntry()` from `lib.mjs` — never
hand-roll index parsing.

## Memory state

Volatile per-entry metadata (accessed, count, tier, dropped) stored in
`<scope>/.claude/memory/YYYY/MM/DD/_meta.json` — gitignored per-date shards. Use
`loadMemoryState(scopeRoot)`, `getMemoryMeta(scopeRoot, relPath)`, `saveMemoryMeta(scopeRoot,
relPath, patch)`, `bumpAccessed(scopeRoot, relPath, date)`, and `dropFromIndex(scopeRoot,
relPath, reason)` — never read/write `_meta.json` directly. Missing `_meta.json` files
self-heal: entries default to path-date accessed/count=1/tier=short.

## Scope isolation

Scopes are discovered purely by filesystem: any directory with `.claude/memory/` is a scope.
`findAllScopes()` discovers all scopes (max depth 4, no name assumptions), skipping any
directory matching a `scopes.ignore` glob/name pattern in `.rem-state.json` (an ignored
parent also prunes its descendants) via the pure `isScopeIgnored()` helper. `rebuildIndex()`
is single-scope — multi-scope rebuilds use explicit `findAllScopes().forEach(rebuildIndex)`.
`scope-validate.mjs` runs at SessionStart (`--fix`) to ensure intermediate file integrity
across all scopes. Each scope owns independent `_meta.json` files and `MEMORY.md`.

## State

Unified state in `.claude/.rem-state.json`. Use `loadState()`/`saveState()` — never
read/write directly. `appendEvent()` for prune log (auto-trims to 15). Hook state keyed under
`state.hook`, prune state under `state.prune`.

### deepMerge preserves foreign keys

`deepMerge` must preserve keys in `partial` that are not in `DEFAULT_STATE`. Other plugins
(e.g. sharp-review) store their state under the same file — silent drop on load→save would
lose their data. When adding a new key to `DEFAULT_STATE`, add it here first, then propagate
to all `*/shared/state.mjs` copies. Bundle integrity test enforces per-plugin copies stay in
sync with `cc-market/shared/`.

## Tests

Tests across files in `rem/tests/*.test.mjs`. Run all: `node --test cc-market/rem/tests/*.test.mjs`. Pre-commit hook enforces.
