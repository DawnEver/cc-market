---
name: scope-ignore
description: scopes.ignore in .rem-state.json lets findAllScopes/findChildScopes skip directories by name/glob
metadata:
  type: feature
---

# Scope ignore for memory discovery

`findAllScopes`/`findChildScopes` in `rem/lib.mjs` now skip directories matching
`scopes.ignore` patterns from `.rem-state.json`.

- New `scopes: { ignore: [] }` key in `DEFAULT_STATE` (`cc-market/shared/state.mjs`),
  bundled to all 6 plugin `*/shared/state.mjs` copies (bundle-integrity enforces sync).
- Pure helper `isScopeIgnored(name, rel, patterns)` (exported, tested): bare patterns
  (no `/`) match a directory basename; patterns with `/` match the path relative to the
  scan root; both support `*`/`?` via `globToRegExp`.
- An ignored parent also prunes its descendants (`continue` before recursing).
- `findAllScopes(base, ignore)`/`findChildScopes(scopeRoot, ignore)` take an optional
  `ignore` arg (used by tests); when omitted they read state via `resolveIgnore`.
- 9 new tests in `rem/tests/lib.test.mjs` (now 26). Full rem suite 183 green.
- Docs updated: `state-schema.md`, rem `invariants.md`, `cc-market/AGENTS.md` test table.
