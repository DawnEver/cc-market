---
name: sharp-review-cache-lag-failure
description: sharp-review workflow failed (args.stats.files undefined) because the installed plugin cache (1.1.5) lags behind the cc-market dev repo's fix
metadata:
  type: project
---

`/sharp-review` ran via `Workflow({scriptPath: "C:\Users\linxu\.claude\plugins\cache\cc-market\sharp-review\1.1.5\scripts\sharp-review-workflow.js", ...})` and failed:
`Error: undefined is not an object (evaluating 'args.stats.files')` at workflow.js:150.

The dev repo (`Sync\claude\cc-market\sharp-review\scripts\sharp-review-workflow.js`) already
guards this with `const stats = args.stats || {...}` at line 160 — the cached 1.1.5 build
running from `~/.claude/plugins/cache/cc-market/sharp-review/1.1.5/` is an older snapshot
without that fix.

**Why:** Same root cause as [[traceme-sync-fix]] — `~/.claude/plugins/cache/cc-market/...`
and `~/.claude/plugins/marketplaces/cc-market` are separate clones/snapshots from the dev
repo at `Sync\claude\cc-market`, and lag behind it. See also [[cc-market-separate-repo]].

**How to apply:** When a cc-market plugin skill/workflow throws an error that looks already
fixed in the dev repo source, check `~/.claude/plugins/cache/cc-market/<plugin>/<version>/`
for a stale copy before debugging the dev repo — the fix may already exist there and just
needs to be synced/reinstalled (e.g. via `/migrate` or plugin update). Don't re-fix the same
bug in the dev repo if it's already fixed there.
