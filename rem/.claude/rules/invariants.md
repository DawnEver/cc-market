# REM Invariants

Always-injected behavioral constraints for working on the rem plugin.

## The tree is the only source of truth — and no memory file is ever deleted

Reading memory never writes: no hook, recall or report records an access, and no per-entry
state exists beside the files. NOTHING deletes a file under `.claude/memory/` (user ruling
2026-10-31; `tests/lifecycle.test.mjs` scans every script for a file-removing call). An entry
is never edited either: a correction or restatement is a NEW entry naming the old one
(`corrects:` flags it; `supersedes:` / `merged_from:` hide it) — visibility is derived, the file stays.
`scope-split.js` moves nothing: an entry's path is part of its identity.

## Only the user opens a task; a journal is append-only

`.claude/tasks/<slug>/TASK.md` is written only by the user's `/rem:task open|close` (command
expansion, not a tool call). `hooks/task-guard.js` refuses an agent writing a `TASK.md`, rewriting a
`JOURNAL.md`, or running `task.js open|close` — keep that hook registered and its planted-control
test (`tests/tasks.test.mjs`) green. A journal grows only by `appendJournal()` (O_APPEND). Close
distills first, then ARCHIVES the task by `git mv` into `.claude/memory/<date>/task-<slug>/` —
never a delete (`closeTask()`).

## One backlog, no checkboxes in memory

A task's open items are journal lines; a repo backlog item is an issue (`.claude/rem.json`
`{"backlog": "issues"}` makes `todo.js` a read-only view) or one `.claude/todo/<id>.md` file, archived
into memory when closed (written whole, O_EXCL; only then does the `.claude/todo/` item go). Nothing writes a checkbox or a status into a memory entry.

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

Content fields (`name`, `description`, `metadata.type`, optional provenance `merged_from` /
`supersedes` / `corrects`, written only by the newer entry) live in file YAML
frontmatter. There is no volatile metadata anywhere. Full schema is in
`skills/rem/reference/memory-conventions.md`.

## Index → `skills/rem/reference/memory-conventions.md`

`.claude/memory-index.md` is derived, gitignored, outside `rules/`, and written only through
`rebuildIndex()` (a pure function of the tree, byte-identical on every machine — byte-order
sorting, POSIX paths — written only when its bytes change; no lock, no hand edits). Its line format is
`formatIndexEntry()` in `lib.mjs`.

## Scope isolation

Scopes are discovered purely by filesystem: any directory with `.claude/memory/` is a scope.
`findAllScopes()` discovers all scopes (max depth 4), `isScopeIgnored()` skips directories
matching `scopes.ignore` patterns. Each scope owns its own memory tree and derived `memory-index.md`.

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
