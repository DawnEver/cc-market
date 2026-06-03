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

Every memory file must have YAML frontmatter: `name`, `description`, `created`, `accessed`, `tier`. Use `stampMissingFields()` to backfill. `created`/`accessed` are ISO dates (YYYY-MM-DD). `tier` is `short` or `long`.

## Index

`MEMORY.md` entries sorted by `accessed` descending. Regex for parsing: `ENTRY_RE` in `lib.mjs`. Max 20 entries (`MAX_ENTRIES`). Use `parseIndex()` and `formatIndexEntry()` — never hand-roll index parsing.

## State

Unified state in `.claude/.rem-state.json`. Use `loadState()`/`saveState()` — never read/write directly. `appendEvent()` for prune log (auto-trims to 50). Hook state keyed under `state.hook`, prune state under `state.prune`.

## Tests

87 tests across 2 files. Run: `node --test cc-market/rem/tests/lib.test.mjs cc-market/rem/tests/rem-hook.test.mjs`. Pre-commit hook enforces.
