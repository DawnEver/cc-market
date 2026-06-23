# Scope split (user-gated)

Relocate a cluster of memory entries into a **child scope** when a scope's memory has grown
large *and* a real subdirectory already owns a cohesive cluster of entries. This is distinct
from **compact** (which distills memory → `.claude/rules/rem/`): a split moves entries into a
nested scope that gets its own independent `.claude/memory/` + `MEMORY.md`.

Generic and structure-agnostic. A child scope only forms where a real internal module
boundary already exists (a `packages/x`, `src/auth`, `lib/foo` subdir the clustered entries
reference). In a flat single-package repo with no such boundary, `--check` exits 1 and nothing
is proposed — the mechanism self-disables. Every split is confirmed by the user, one at a time.

## When to run

After prune, alongside the compact check. Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --check
```

Exit 0 = at least one split candidate exists. Exit 1 = skip (proceed with normal REM).

## Procedure (only if --check exits 0)

1. **Propose** — list candidate child scopes and the entries that would move:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --propose
   ```
   Output JSON: `{ scopeRoot, candidates: [{ scope, entryCount, entries[], rationale }] }`.

2. **Confirm with the user** — present each candidate (scope subdir, entry count, rationale)
   via `AskUserQuestion`. The user approves splits individually; never split without an
   explicit yes. The user may approve some candidates and reject others.

3. **Execute** — for each approved candidate:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-split.js --execute \
     --scope <subdir> --entries <rel1,rel2,...>
   ```
   This **moves** each entry file into `<subdir>/.claude/memory/<same date path>`, records a
   `dropped: 'migrated→<subdir>'` tombstone in the parent's `_meta.json` (carrying tier/access
   metadata over to the child), and rebuilds both indexes. The parent's `## Scoped` section
   auto-updates to link the new child scope.

4. **Update prose** — if the split is architecturally meaningful, update the parent project's
   `AGENTS.md` / `README.md` "Scoped" prose to mention the new child scope (per the rem standard
   "When memory entries are created or split").

## Thresholds (overridable)

Defaults: `minOwnEntries: 30`, `minClusterEntries: 5`, `maxBytes: 500*1024`. Override per-repo
in `.claude/.rem-state.json` under `scopes.split`:

```json
{ "scopes": { "split": { "minOwnEntries": 40, "minClusterEntries": 8 } } }
```

Size pressure is met when own (non-child) entry count ≥ `minOwnEntries` **OR** total own memory
bytes > `maxBytes`. A subdir becomes a candidate only when it additionally owns ≥
`minClusterEntries` entries, exists on disk, is not already a scope, and is not in `scopes.ignore`.

## Invariant note

A split is the one operation permitted to remove a file from a scope's own memory tree — it
*relocates* rather than evicts, leaving a `migrated→` tombstone so history is never silently
lost. `scope-validate.mjs` flags dangling tombstones whose child scope is missing.
