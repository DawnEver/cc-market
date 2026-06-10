# Multi-Device Sync — Setup & Privacy

## Environment

- `TRACEME_SYNC_REMOTE` — Git remote URL for the sync data repo (required for push/pull/aggregate)
- `TRACEME_DEVICE_NAME` — Override device name (default: hostname)

## Multi-Device Key Sharing

All devices share the same symmetric key. After `traceme sync setup` on device A:

1. Copy `~/.claude/traceme/key.txt` to device B at the same path
2. Run `traceme sync setup` on device B (skips key gen, just inits repo)

## Sync Data Model (what gets synced)

- `daily_summary` table (per-project aggregates: tokens, cost, sessions)
- `sessions` metadata (id, project, branch, timestamps, counts — NO prompt text, NO paths)
- `tool_usage` / `skill_usage` aggregated counts

Prompt text and project paths are excluded per the privacy invariant — never included in any
sync/export path. The sync repo contains ONLY `.enc` (age-encrypted) files; no plaintext ever
touches GitHub.
