#!/usr/bin/env node
// One-time repair: reverse the mass `over-capacity` drops written by the OLD prune
// capacity treadmill, which — under sustained high write volume (50-120 notes/day) —
// dropped every short-term entry not in the "newest 20 by accessed" instant, hiding
// ~1234 real notes from both the index and recall.
//
// Append-only is respected: the memory .md files were never deleted; only a
// `dropped: over-capacity` tombstone was set in _meta.json. This script clears that
// tombstone and reconstructs `accessed` from the file's creation date (the true
// access history was clobbered by the drop), so recall and the index see them again.
// The time-based prune (scripts/prune-memory.js) then keeps only genuinely recent
// entries and legitimately drops true >90d staleness as `stale-90d`.
//
// Run: node scripts/repair-overcapacity.js [--dry-run] [--quiet]

import { join } from 'path';
import { withLock } from '../shared/lock.mjs';
import {
  loadMemoryState, saveMemoryMeta, appendEvent, rebuildIndex, findAllScopes,
} from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const quiet = process.argv.includes('--quiet');
function log(...args) { if (!quiet) console.log(...args); }

// Reconstruct a created-date from the nested path 2026/MM/DD/slug.md.
function createdFromPath(relPath) {
  const m = relPath.match(/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const scopes = findAllScopes();
let total = 0;

for (const scope of scopes) {
  const state = loadMemoryState(scope);
  const victims = [];
  for (const [relPath, meta] of state) {
    if (relPath.startsWith('tasks/')) continue;
    if (meta.dropped !== 'over-capacity') continue; // only the wrongful mass drop
    const created = createdFromPath(relPath);
    if (!created) continue;
    victims.push({ relPath, created });
  }
  if (victims.length === 0) continue;

  log(`[repair] ${scope}: ${victims.length} over-capacity drop(s) to restore`);
  if (dryRun) { total += victims.length; continue; }

  try {
    withLock(join(scope, '.claude', 'memory', '.repair'), () => {
      for (const v of victims) {
        saveMemoryMeta(scope, v.relPath, {
          dropped: undefined,     // clear the tombstone (undefined key is dropped on write)
          accessed: v.created,    // true access history was lost — recreate from creation
          count: 1,               // start short; must re-earn promotion over the 90d window
          tier: 'short',
        }, { onTimeout: 'throw' });
        appendEvent('repair', { path: v.relPath, reason: 'restore-overcapacity' }, { onTimeout: 'throw' });
        total++;
      }
    }, { onTimeout: 'throw' });
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') {
      console.error(`[repair] another process holds the repair lock for ${scope} — retry when clear`);
      process.exit(1);
    }
    throw err;
  }

  // Rebuild both the injected hot index and the full catalog for this scope.
  rebuildIndex(scope, { onTimeout: 'throw' });
}

log(`[repair] ${dryRun ? 'would restore' : 'restored'} ${total} over-capacity entry/entries`);
