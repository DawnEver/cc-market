---
name: shared-bundle
description: Bundled shared/ into each plugin for self-contained cc-market distribution — import path fix, pre-push automation, integrity tests
---

# cc-market shared/ bundling (2026-06-09)

## What changed

Plugins previously imported from `../../shared/lib.mjs` which broke in the versioned plugin cache (`rem/1.0.9/` has no `../../shared`). Fix: each plugin now commits its own `<plugin>/shared/` with copied files.

## Import path convention

| File location | Import path |
|---|---|
| `<plugin>/lib.mjs` (root) | `'./shared/lib.mjs'` |
| `<plugin>/hooks/*.js` | `'../shared/lib.mjs'` |
| `<plugin>/scripts/*.js` | `'../shared/lib.mjs'` |

Takeover does NOT use shared/ — no bundled copy needed.

## pre-push hook

`bundle_shared()`: atomic copy via mktemp → mv; fails loudly if shared/ has no .mjs files. New-branch pushes (remote_sha=0) always set SHARED_CHANGED=1 since single-commit range misses history.

## Integrity test

`tests/bundle-integrity.test.mjs`: detects plugins needing shared/ by scanning imports (not by shared/ presence), asserts directory exists, checks file content matches canonical shared/, checks no `../../shared/` imports remain.
