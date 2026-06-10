---
name: traceme-sync-fix
description: traceme sync-hook never pushed because TRACEME_SYNC_REMOTE was unset; fixed env var + hook now also auto-aggregates
metadata:
  type: project
---

`cc-market/traceme/hooks/sync-hook.js` gated push behind `process.env.TRACEME_SYNC_REMOTE`,
but that env var was never set anywhere (the sync repo's git `origin` was configured fine,
and `sync.mjs`'s `getRemote()` already falls back to it — but the hook's own check
short-circuited before reaching `sync.mjs`). Result: Stop/SessionEnd auto-push silently
never ran, even though `traceme stats`/`sync verify` looked healthy.

Fix applied (uncommitted in `cc-market` dev clone, `traceme/hooks/sync-hook.js`):
- Added `TRACEME_SYNC_REMOTE=https://github.com/DawnEver/traceme-history.git` to
  `claude_settings.json` env.
- Removed the redundant env check in `sync-hook.js`.
- Hook now also calls `aggregateAndPush()` after `pushSnapshot()` every session end —
  replaces the need for a separate daily `traceme sync aggregate` cron (cron jobs only
  last ~7 days in this harness, per user).

**Why:** user wants per-device push on session end AND daily cross-device aggregation,
without relying on short-lived cron jobs.

**How to apply:** When debugging traceme sync issues, check both (1) whether
`TRACEME_SYNC_REMOTE` is set / `sync-repo` has a working `origin`, and (2) whether
`hooks/sync-hook.js` actually reaches `pushSnapshot()`/`aggregateAndPush()` — env-var gates
in hooks can silently no-op even when the underlying script would work fine standalone.

**Outstanding:** change is only in `Sync\claude\cc-market` (dev clone of
`DawnEver/cc-market`, same commit as `~/.claude/plugins/marketplaces/cc-market` but a
separate clone). Not yet committed/pushed, and the marketplace clone (which actually runs
the hooks) needs to pull this commit to take effect.
