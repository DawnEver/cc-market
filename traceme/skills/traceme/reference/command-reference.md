# TraceMe CLI Command Reference

Full flag reference for `traceme-cli.mjs`. All commands run as:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" <command> [flags]
```

## Report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --json        # JSON output
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --local       # Local-only (skip merged data)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --brief       # Compact summary
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --project foo # Filter by project name
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --range 7d    # Last 7 days
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --from 2026-06-01 --to 2026-06-10  # Date range
```

## Stats (alias for `report today --brief`)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats --local
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats --project foo
```

## Status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" status         # DB health + sync config
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" status --sync  # Full sync diagnostics
```

## Sync (multi-device encrypted)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync setup [--key <hex>]  # Generate encryption key, init sync repo
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync set-key <hex>       # Adopt another device's key
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync push today          # Encrypt + push daily snapshot
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync pull today          # Pull + import other devices
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync verify today        # Check consistency
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync status              # Alias for `status --sync`
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync forget <device-id>  # Remove a device's snapshots
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync rebuild             # Reset and repush all local data
```

Requires `TRACEME_SYNC_REMOTE` env var set to the sync repo URL. Zero external dependencies — uses Node built-in `crypto` for AES-256-GCM encryption.

For first-time multi-device setup (key sharing) and what data is/isn't synced (privacy) → `sync.md`.

## Export

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" export today            # Export daily summary as JSON
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" export today --csv      # Export daily summary as CSV
```

Exports daily summaries (per-project aggregates: tokens, cost, sessions) in JSON or CSV format. Prompt text is never included (privacy invariant).

## Rescan

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" rescan            # Incremental: only changed transcripts
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" rescan --all      # Full rebuild from every transcript
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" rescan --prune    # Also drop sessions whose transcript is gone
```

Re-derives the local DB from the Claude Code transcripts at `~/.claude/projects/**/*.jsonl`. The DB is purely a cache of jsonl-derived facts, so this is always safe to run — `--all` ignores the per-file cursors and rebuilds everything (use after upgrading or if data looks wrong); `--prune` removes sessions whose source transcript no longer exists.

## Dashboard

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard            # Generate & open interactive HTML dashboard
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard --no-open  # Write file only, don't open browser
```

Generates an interactive HTML dashboard (Apache ECharts, CDN) embedding the last 90 days.
Filter in-browser by date range, projects, devices (all vs. single), grouping (model/project/device/category),
and toggle calendar intensity (tokens/cost) + cache_read layer. Full filter list → `dashboard.md`.
Run `rescan --all` once before first open to backfill older sessions.

## Errors

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" errors
```

Shows the last 50 lines from the hook error log (`~/.claude/traceme/error.log`).

## Date Formats & Quick Reference

```bash
traceme report today                    # Today (cross-device aggregate)
traceme report today --local            # Today (local device only)
traceme report today --json             # Today (JSON output)
traceme report today --brief            # Today (compact summary)
traceme report today --project my-app   # Today, filtered by project
traceme report today --range 7d         # Last 7 days aggregate
traceme report today --from 2026-06-01 --to 2026-06-10  # Custom date range
traceme report yesterday                # Yesterday
traceme report 2026-06-09               # Specific date (YYYY-MM-DD)
traceme stats                           # Quick summary (today, cross-device)
traceme stats --local                   # Quick summary (local only)
traceme stats --project my-app          # Quick summary, filtered
traceme status                          # Database health & sync status
traceme status --sync                   # Full sync diagnostics
traceme sync status                     # Alias for `status --sync`
traceme sync forget linxu-win           # Remove device from sync
traceme sync rebuild                    # Reset sync repo from local data
traceme export today                    # Export daily summary as JSON
traceme export today --csv              # Export daily summary as CSV
traceme rescan                          # Re-derive DB from changed transcripts
traceme rescan --all                    # Full rebuild from all transcripts
traceme rescan --prune                  # Also drop stale sessions
traceme errors                          # Show recent hook errors
traceme help                            # Show all commands
```
