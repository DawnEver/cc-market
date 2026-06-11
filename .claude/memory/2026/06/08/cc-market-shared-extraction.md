---
name: cc-market-shared-extraction
description: Extracted duplicated utilities from 4 plugins into cc-market/shared/ — findProjectRoot, isMain, readStdinJSON, readTranscriptTail, unified state management
metadata:
  type: project
---

# cc-market/shared — 提取共享工具库

Eliminated duplicated code across rem, sharp-review, takeover, watch by creating `cc-market/shared/`.

## New modules

- **`shared/lib.mjs`** — `findProjectRoot(startDir?)`, `isMain(importMeta)`, `readStdinJSON()`, `readTranscriptTail(path, maxLines=40)`
- **`shared/state.mjs`** — `loadState(stateFile)`, `saveState(stateFile, state)`, `appendEvent(stateFile, type, detail)`, `DEFAULT_STATE`

## Key fix: race condition

`sharp-review-hook.js` had its own `loadUnifiedState`/`saveUnifiedState` reading/writing the same `.claude/.rem-state.json` as `rem/lib.mjs`'s `loadState`/`saveState`. The sharp-review version did NOT deep-merge with defaults — a load-modify-save cycle could clobber rem's `hook` and `prune` keys.

**Fix:** `shared/state.mjs` `loadState()` always deep-merges with `DEFAULT_STATE`, ensuring missing keys get defaults even from partial JSON. Both rem and sharp-review now use the same implementation.

## Migration

| Plugin | What switched to shared |
|---|---|
| `rem/lib.mjs` | `findProjectRoot`, `loadState`, `saveState`, `appendEvent` → re-exports |
| `rem/hooks/rem-hook.js` | `readStdinJSON`, `readTranscriptTail`, is-main guard |
| `rem/scripts/check-docs.js` | is-main guard |
| `sharp-review/hooks/sharp-review-hook.js` | All 6 duplicated functions (`findGitRoot` kept as re-export wrapper for test compat) |
| `watch/hooks/alert-hook.js` | `readStdinJSON`, `readTranscriptTail` (TRANSCRIPT_TAIL=60 preserved) |

## Files left untouched

- **takeover/** — uses `node:` prefix consistently, isMain is correct, no bugs
- **rem/lib.mjs** remaining exports (frontmatter, date, index, file collection) — no duplicates
- **sharp-review/lib.mjs** — SR-specific logic, no duplicates

## Verification

177 tests across all plugins pass (shared/state, rem, sharp-review, takeover), zero regressions.
