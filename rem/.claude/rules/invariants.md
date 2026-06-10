# REM Invariants

Always-injected behavioral constraints for working on the rem plugin.

## Append-only

Memory files in `.claude/memory/` are NEVER deleted. `prune-memory.js` and `compact.js` only remove from `MEMORY.md` index — files stay on disk forever.

## Path security

Use `resolveMemoryPath()` + `isInsideMemoryDir()` before any file I/O on paths that could come from user input or index entries.

```js
const file = resolveMemoryPath(relPath);
if (!isInsideMemoryDir(file)) throw new Error("path traversal denied");
```

## Frontmatter

Every memory file must have YAML frontmatter (`name`, `description`, `created`, `accessed`, `tier`, `access_count`). Use `stampMissingFields()` to backfill — never hand-write. Full schema → `skills/rem/reference/memory-conventions.md`.

## Index

`MEMORY.md` entries sorted by `accessed` descending, max 20 (`MAX_ENTRIES`). Use `parseIndex()` and `formatIndexEntry()` from `lib.mjs` — never hand-roll index parsing.

## State

Unified state in `.claude/.rem-state.json`. Use `loadState()`/`saveState()` — never read/write directly. `appendEvent()` for prune log (auto-trims to 50). Hook state keyed under `state.hook`, prune state under `state.prune`.

### deepMerge preserves foreign keys

`deepMerge` must preserve keys in `partial` that are not in `DEFAULT_STATE`. Other plugins (e.g. sharp-review) store their state under the same file — silent drop on load→save would lose their data. When adding a new key to `DEFAULT_STATE`, add it here first, then propagate to all `*/shared/state.mjs` copies. Bundle integrity test enforces per-plugin copies stay in sync with `cc-market/shared/`.

## Tests

Tests across 4 files: `frontmatter.test.mjs`, `date-path.test.mjs`, `lib.test.mjs`, `rem-hook.test.mjs`. Run all: `node --test cc-market/rem/tests/*.test.mjs`. Pre-commit hook enforces.
