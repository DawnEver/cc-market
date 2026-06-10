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
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync aggregate today  # Merge all → main
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync verify today  # Check consistency
```

Requires `TRACEME_SYNC_REMOTE` env var set to the sync repo URL. Zero external dependencies — uses Node built-in `crypto` for AES-256-GCM encryption.

For first-time multi-device setup (key sharing) and what data is/isn't synced (privacy) → `reference/sync.md`.

## Output
Displays today's per-project breakdown: sessions, prompt count, token usage, cost, top expensive prompts, and tool/skill usage.
