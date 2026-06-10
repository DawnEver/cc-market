// traceme migration: transition from device-branch sync format to per-device
// files on main branch. Idempotent — safe to re-run; no-op once current.
//
// Old format: device/<name> branches with YYYY/MM/DD/cc.enc + main aggregated cc.enc
// New format: main branch with YYYY/MM/DD/<device>.enc per-device files

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TRACEME_DIR = join(homedir(), '.claude', 'traceme');
const SYNC_DIR = join(TRACEME_DIR, 'sync-repo');

export async function migrate(_projectRoot) {
  const summary = [];
  let changed = false;

  // Only relevant if sync is set up
  if (!existsSync(join(SYNC_DIR, '.git'))) {
    return { changed, summary };
  }

  // The migration is straightforward: old cc.enc files on device branches and
  // main are left in place (they'll be ignored by the new code which only reads
  // <device>.enc files). Users can re-push with `traceme sync push --all` to
  // populate the new per-device format from their local SQLite data.
  //
  // For now, this is a no-op skeleton — the real migration (decrypt old device
  // branches → re-encrypt as per-device files on main) would be destructive
  // and should only run when the user explicitly requests it.
  summary.push('traceme: old device-branch snapshots can be migrated by running `traceme sync push --all` on each device');
  summary.push('traceme: new per-device format uses YYYY/MM/DD/<device>.enc on main branch');

  return { changed, summary };
}
