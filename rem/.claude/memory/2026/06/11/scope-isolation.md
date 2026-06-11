---
name: scope-isolation
description: Scope isolation mechanism — per-scope state files, generated index, filesystem-driven discovery
metadata:
  type: project
---

# Scope Isolation

## Scope definition

A scope is any directory containing `.claude/memory/`. Discovery is purely filesystem-driven:
- `findMemoryScope()` walks up from cwd to find the nearest `.claude/memory/`
- `findAllScopes()` walks down from repo root (≤4 levels deep), matching any directory with `.claude/memory/`
- No assumptions about directory names — works in any project structure

Parent repo root, subdirectories, and plugin directories are each independent scopes.

## Per-scope intermediate files

Each scope has complete, independent intermediate files:

```
<scopeRoot>/.claude/
├── memory/YYYY/MM/DD/
│   ├── *.md           ← content (git-tracked)
│   └── _meta.json     ← daily metadata shard (gitignored)
└── rules/
    └── MEMORY.md      ← generated index (gitignored, device-local)
```

Path derivation is uniform: `join(scopeRoot, '.claude', ...)` — no per-type branching.

## rebuildIndex is single-scope

`rebuildIndex(scopeRoot)` operates on one scope only — it collects `.md` files from that scope's memory dir, reads metadata from `_meta.json` files, and writes `MEMORY.md`. Multi-scope rebuilds use explicit loops at the call site: `findAllScopes().forEach(rebuildIndex)`.

## Scope validation

`scope-validate.mjs` runs at SessionStart (via `prune-memory.js`) with `--fix` to ensure intermediate file integrity:
- Missing `_meta.json` → initialized as `{}`
- Missing `MEMORY.md` → rebuilt via `rebuildIndex`
- Corrupt `_meta.json` → reset to `{}`

## Multi-scope task display

`/todo report` recursively scans all scopes via `scanAllScopes()` and groups output by scope header. Add/remove/mark operations target only the current scope (detected from cwd).

## Volatile metadata

`accessed`, `count`, `tier`, and `dropped` live only in `_meta.json` — never in frontmatter. Missing state self-heals: entries default to path-date accessed, count=1, tier=short. Memory file frontmatter contains only content fields: `name`, `description`, `metadata.type`.
