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
```

### Stats
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats
```

### Sync (multi-device encrypted)
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync setup      # Generate age keypair, init repo
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync push today  # Encrypt + push daily snapshot
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync pull today  # Pull + import other devices
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync verify today  # Check consistency
```

Requires `TRACEME_SYNC_REMOTE` env var set to the sync repo URL. Zero external dependencies — uses Node built-in `crypto` for AES-256-GCM encryption.

For first-time multi-device setup (key sharing) and what data is/isn't synced (privacy) → `reference/sync.md`.

## Data Source

By default, `report` and `stats` show the **cross-device aggregate** — data merged from all your devices via encrypted sync. This is read from the locally cached `origin/main` git ref (no network call), so it reflects the last sync.

If no cross-device data exists for the requested date (sync not set up, or nothing pushed yet), output falls back to local SQLite data. Pass `--local-only` to always force the local view:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today --local-only
```

The **Top Expensive Prompts** section is always local-only — prompt text is never synced.

## Privacy

- Prompt text is stored locally only — never included in any sync or export path
- The sync repo contains ONLY `.enc` (AES-256-GCM encrypted) files — no plaintext ever touches GitHub
- Project paths are excluded from sync data
- Encryption key is stored locally at `~/.claude/traceme/key.txt` and never committed

## Date Formats

```bash
traceme report today          # Today
traceme report yesterday      # Yesterday
traceme report 2026-06-09     # Specific date (YYYY-MM-DD)
traceme stats                 # Quick summary for today
traceme help                  # Show all commands
```

## Output
Displays today's per-project breakdown: sessions, prompt count, token usage, cost, top expensive prompts, and tool/skill usage.
