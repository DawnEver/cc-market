# Multi-Device Sync — Setup, Privacy & Data Model

## Environment

- `TRACEME_SYNC_REMOTE` — Git remote URL for the sync data repo (required for push/pull/aggregate)
- `TRACEME_DEVICE_NAME` — Override device name (default: hostname)

## Multi-Device Key Sharing

All devices share the same symmetric key. After `traceme sync setup` on device A:

1. Copy `~/.claude/traceme/key.txt` to device B at the same path
2. Run `traceme sync setup` on device B (skips key gen, just inits repo)

## Architecture

All devices push per-device `.enc` files directly to `main`. Only `.enc` files (age-encrypted)
touch the remote repo. The sync repo is separate from the config repo.

```
Device A (linxu-win)             GitHub (traceme-history)         Device B (linxu-mac)
     |                                |                                |
     | traceme sync push             |                                |
     | → dump SQLite → JSON          |                                |
     | → age encrypt                 |                                |
     | → push main:YYYY/MM/DD/       |                                |
     |        linxu-win.enc          |                                |
     |──────────────────────────────>|                                |
     |                                |                                |
     |                                |     traceme sync pull         |
     |                                |     → fetch main               |
     |                                |     → decrypt linxu-win.enc    |
     |                                |     → merge into SQLite        |
     |                                |<───────────────────────────────|
```

### Repo Structure

Snapshot paths are `YYYY/MM/DD/<device-name>.enc` — one directory per day, one `.enc` file per
device:

```
main:
  2026/06/09/
    linxu-win.enc
    linxu-mac.enc
  2026/06/10/
    linxu-win.enc
    linxu-mac.enc
```

## Sync Data Model (what gets synced)

- `daily_summary` table (per-project aggregates: `billable_tokens`, `cache_read_tokens`, cost, sessions)
- `sessions` metadata (id, project, branch, timestamps, counts, `active_min` — NO prompt text, NO paths)
- `tool_usage` aggregated counts
- `model_facts` (per project x model components — lights up cross-device per-model views)
- `skill_usage` (per project x skill call counts — cross-device skill rankings)

Prompt text and project paths are excluded per the privacy invariant — never included in any
sync/export path. The sync repo contains ONLY `.enc` (AES-256-GCM encrypted) files; no plaintext ever
touches GitHub.

## Merge Readers

`sync.mjs` exposes three merge readers (all read from cached `origin/main`, no network):

- `loadDeviceSnapshots({from, to, skipSelf})` — low-level reader, reads all device `.enc` files
  in a date range from cached `origin/main`
- `readMergedSnapshot(date)` — per-day merge (for report/insights), merges all devices' daily
  summaries
- `readDeviceFacts(from, to)` — per-device rows + per-device `modelFacts` (for the dashboard's
  all-devices vs. single-device view). The local device is excluded — the live DB represents it,
  avoiding double-count against its pushed snapshot.

## Report Data Source

`traceme report`/`traceme stats` show the **cross-device aggregate** by default, labeled
`Aggregated across N device(s): ...`. Data is read via the locally cached `origin/main` ref —
no network call, relies on a prior `sync pull` having fetched `origin`.

If no merged snapshot exists for the date (sync not set up, or nothing aggregated yet), output
falls back to local-SQLite-only data, labeled `Local-only (no cross-device aggregate available)`.
Pass `--local` to always force the local view.

## Key Files

| File | Role |
|------|------|
| `scripts/crypto.mjs` | Zero-dep AES-256-GCM encryption (Node `crypto`, no external CLI) |
| `scripts/sync.mjs` | Sync engine: dump, encrypt, push, pull, decrypt, merge, verify, backfill |
| `~/.claude/traceme/key.txt` | Symmetric key (hex, never committed, gitignored) |
| `~/.claude/traceme/sync-repo/` | Local clone of traceme-history repo |

## Sync Health

```bash
traceme sync status
```

Shows encryption key fingerprint, configured remote, local sync repo status, and
`last_push`/`last_pull` timestamps — useful for diagnosing sync issues across devices.
