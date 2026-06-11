---
name: traceme-merged-default
description: traceme report/stats now default to main's cross-device merged aggregate via cached origin/main, fall back to local-only
metadata:
  type: project
---

`traceme report`/`traceme stats` now default to the cross-device aggregate (`merged/<date>.enc`
on `main`), read via the cached `origin/main` ref (`git show origin/main:merged/<date>.enc` +
decrypt) — no network call. New `sync.mjs` export `readMergedSnapshot(date)`.

**Why:** previously local report only showed this device's SQLite data; user wanted local
display to "always equal main's full cross-device aggregate" without a network round-trip per
report.

**How to apply:**
- `--local-only` flag forces the old local-SQLite-only view (banner: "Local-only (no
  cross-device aggregate available)").
- Default banner: "Aggregated across N device(s): a, b (as of aggregated_at)".
- `verifyConsistency()` refactored to use `readMergedSnapshot()` instead of reading
  `merged/<date>.enc` from the sync repo working tree directly.
- `TRACEME_KEY_FILE` env override (in `crypto.mjs`) lets tests force `isSyncSetup()` false
  deterministically — used instead of adding a new `TRACEME_SYNC_DIR` override (declined).
- All 32 traceme tests pass; pre-commit hook updated to include traceme test suites.
- NOT YET COMMITTED in cc-market repo as of 2026-06-10 — confirm with user before committing.
