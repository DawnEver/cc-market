---
name: traceme
description: Personal observability for Claude Code — daily token/cost reports, tool usage, project stats, encrypted multi-device sync
---

# TraceMe

Personal Claude Code observability — track your daily token usage, cost, tool usage, and project stats.

## Common commands

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today       # Daily report (e.g. --brief for compact)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" rescan             # Re-derive DB from changed transcripts (--all = full rebuild)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard          # Interactive HTML dashboard (--no-open to skip browser)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" sync push today    # Encrypt + push daily snapshot to sync repo
```

Other commands: `stats`, `status`, `export`, `errors`, `sync <setup|pull|verify|status|forget|rebuild|set-key>`.

**Full CLI reference** (every command, all flags, date formats like `yesterday` / `YYYY-MM-DD` / `--range 7d`) → `reference/command-reference.md`.
Multi-device sync setup & privacy → `reference/sync.md`. Dashboard filters → `reference/dashboard.md`.

## Model Pricing

Model pricing is stored at `~/.claude/traceme/model_pricing.json`. On first run, a default file is created with current pricing for Claude and DeepSeek models. Edit this file to update pricing or add new models — it persists across plugin updates.

## Data Source

By default, `report` and `stats` show the **cross-device aggregate** — data merged from all your devices via encrypted sync. This is read from the locally cached `origin/main` git ref (no network call), so it reflects the last sync.

Cross-device data is auto-pulled at session start when sync is configured. If no cross-device data exists for the requested date (sync not set up, or nothing pushed yet), output falls back to local SQLite data. Pass `--local` to always force the local view.

## Privacy

- Prompt text is **never** stored or read — the scanner counts prompts but never persists their content (structural guarantee)
- The sync repo contains ONLY `.enc` (AES-256-GCM encrypted) files — no plaintext ever touches GitHub
- Project paths are excluded from sync data
- Encryption key is stored locally at `~/.claude/traceme/key.txt` and never committed

## Output

Displays today's per-project breakdown: sessions, prompt count, token usage, cost, top expensive prompts, and tool/skill usage. Use `traceme export` to export daily summaries as JSON or CSV.
