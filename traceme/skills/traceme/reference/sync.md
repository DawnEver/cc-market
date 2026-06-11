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
sync/export path. The sync repo contains ONLY `.enc` (AES-256-GCM encrypted) files; no plaintext ever
touches GitHub.

## Report Data Source

`traceme report`/`traceme stats` show the **cross-device aggregate** (`YYYY/MM/DD/cc.enc` from
`main`) by default, labeled `Aggregated across N device(s): ...`. This is read via the locally
cached `origin/main` ref (`git show origin/main:YYYY/MM/DD/cc.enc` + decrypt) — no network call,
relies on a prior `sync push`/`aggregate`/`pull` having fetched `origin`.

If no merged snapshot exists for the date (sync not set up, or nothing aggregated yet), output
falls back to local-SQLite-only data, labeled `Local-only (no cross-device aggregate available)`.
Pass `--local` to always force the local view.

The **Top Expensive Prompts** section is always local-only — prompt text is never synced (see
privacy invariant above), so it cannot be part of the cross-device aggregate.

## Sync Health

```bash
traceme sync status
```

Shows encryption key fingerprint, configured remote, local sync repo status, and
`last_push`/`last_pull` timestamps — useful for diagnosing sync issues across devices.
