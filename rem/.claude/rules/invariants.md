# REM Invariants

Always-injected behavioral constraints for working on the rem plugin.

## Append-only (with one carve-out: relocation)

Memory files in `.claude/memory/` are NEVER deleted. `prune-memory.js` and `crystallize.js` only
mark entries as dropped in `_meta.json` — files stay on disk forever.

The single exception is `scope-split.js`, which may **relocate** a file from a parent scope
into a child scope's memory tree (move, not evict). It records a `dropped: 'migrated→<subdir>'`
tombstone in the parent's `_meta.json` so the move is traceable and history is never silently
lost. `scope-validate.mjs` flags dangling `migrated→` tombstones whose child scope is missing.
This is a structural relocation, not an eviction — never treat it as license to delete memory.

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

Content fields (`name`, `description`, `metadata.type`) live in file YAML frontmatter. Volatile
metadata (`accessed`, `count`, `tier`, `dropped`) lives in per-date `_meta.json` — never in
frontmatter. Full schema is in `skills/rem/reference/memory-conventions.md`.

## Index → `skills/rem/reference/memory-conventions.md`

`MEMORY.md` is a generated, gitignored file. Use `parseIndex()` / `formatIndexEntry()` from
`lib.mjs` — never hand-roll index parsing. Index rules (max entries, sort order) are in
`skills/rem/reference/memory-conventions.md`.

## Memory state → `skills/rem/reference/state-schema.md`

Use `loadMemoryState()`, `getMemoryMeta()`, `saveMemoryMeta()`, `bumpAccessed()`, and
`dropFromIndex()` — never read/write `_meta.json` directly. The state schema is in
`skills/rem/reference/state-schema.md`.

## Scope isolation

Scopes are discovered purely by filesystem: any directory with `.claude/memory/` is a scope.
`findAllScopes()` discovers all scopes (max depth 4), `isScopeIgnored()` skips directories
matching `scopes.ignore` patterns. Each scope owns independent `_meta.json` files and `MEMORY.md`.

## State

Unified state in `.claude/.rem-state.json`. Use `loadState()`/`saveState()` — never
read/write directly. `appendEvent()` for prune log (auto-trims to 15).

### deepMerge preserves foreign keys

`deepMerge` must preserve keys in `partial` that are not in `DEFAULT_STATE`. Other plugins
(e.g. sharp-review) store their state under the same file — silent drop on load→save would
lose their data. When adding a new key to `DEFAULT_STATE`, add it here first, then propagate
to all `*/shared/state.mjs` copies. Bundle integrity test enforces per-plugin copies stay in
sync with `cc-market/shared/`.

## Tests

Tests across files in `rem/tests/*.test.mjs`. Run all: `node --test cc-market/rem/tests/*.test.mjs`. Pre-commit hook enforces.
