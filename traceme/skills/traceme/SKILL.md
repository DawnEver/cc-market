---
name: traceme
description: Personal observability for Claude Code — daily token/cost reports, tool usage, project stats, encrypted multi-device sync
---

# TraceMe

Personal Claude Code observability — track your daily token usage, cost, tool usage, and project stats.

## Commands

### Report
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --json        # JSON output
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --local       # Local-only (skip merged data)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --brief       # Compact summary
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --project foo # Filter by project name
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --range 7d    # Last 7 days
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --from 2026-06-01 --to 2026-06-10  # Date range
```

### Stats (alias for `report today --brief`)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats --local
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats --project foo
```

### Status
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" status         # DB health + sync config
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" status --sync  # Full sync diagnostics
```

### Sync (multi-device encrypted)
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

For first-time multi-device setup (key sharing) and what data is/isn't synced (privacy) → `reference/sync.md`.

### Export
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" export today            # Export daily summary as JSON
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" export today --csv      # Export daily summary as CSV
```

Exports daily summaries (per-project aggregates: tokens, cost, sessions) in JSON or CSV format. Prompt text is never included (privacy invariant).

### Prune
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" prune 90                      # Delete old prompt text
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" prune 90 --keep-stats         # Delete text but preserve stats
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" prune 90 --dry-run            # Preview what would be deleted
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" prune 90 --tool-calls         # Also prune tool call data
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" prune 90 --keep-stats --tool-calls  # Clear summaries only
```

Removes stored prompt text and/or tool call summaries to save disk space. `--keep-stats` retains aggregated statistics while only deleting the full text. `--dry-run` shows count without making changes. Use `--tool-calls` to also prune the `tool_calls` table.

### Errors
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" errors
```

Shows the last 50 lines from the hook error log (`~/.claude/traceme/error.log`).

## Model Pricing

Model pricing is stored at `~/.claude/traceme/model_pricing.json`. On first run, a default file is created with current pricing for Claude and DeepSeek models. Edit this file to update pricing or add new models — it persists across plugin updates.

## Data Source

By default, `report` and `stats` show the **cross-device aggregate** — data merged from all your devices via encrypted sync. This is read from the locally cached `origin/main` git ref (no network call), so it reflects the last sync.

Cross-device data is auto-pulled at session start when sync is configured. If no cross-device data exists for the requested date (sync not set up, or nothing pushed yet), output falls back to local SQLite data. Pass `--local` to always force the local view.

The **Top Expensive Prompts** section is always local-only — prompt text is never synced.

## Privacy

- Prompt text is stored locally only — never included in any sync or export path
- The sync repo contains ONLY `.enc` (AES-256-GCM encrypted) files — no plaintext ever touches GitHub
- Project paths are excluded from sync data
- Encryption key is stored locally at `~/.claude/traceme/key.txt` and never committed

## Date Formats

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
traceme prune 90                        # Delete old prompt text
traceme prune 90 --dry-run              # Preview what would be deleted
traceme prune 90 --tool-calls           # Also prune tool calls
traceme errors                          # Show recent hook errors
traceme help                            # Show all commands
```

## Output
Displays today's per-project breakdown: sessions, prompt count, token usage, cost, top expensive prompts, and tool/skill usage. Use `traceme export` to export daily summaries as JSON or CSV.
