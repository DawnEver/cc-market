#!/usr/bin/env node
// Prune memory retention by TIME, not by a fixed count cap:
//   - Promote-first: short-term at count>=3 → long (protected), before any eviction.
//   - Short-term (>90d stale): evict from index (entries with frontmatter
//     `metadata.type: feedback` are exempt from the 90-day stale eviction —
//     explicit user corrections have long-term value)
//   - Long-term (not accessed since last prune): demote to short
// There is NO count-based capacity cap. Eviction is time-based only, so an active
// working set is never silently dropped by a fixed-size treadmill — a file has the
// full 90 days to be re-accessed and promoted instead of dying to make room.
// Run: node scripts/prune-memory.js [--dry-run] [--evict-stale] [--quiet]
// Called by SessionStart hook; runs scope-validate --fix first.

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter as parseNestedFrontmatter } from '../shared/lib.mjs';
import { withLock } from '../shared/lock.mjs';
import { withStateLock } from '../shared/state.mjs';
import {
  scopeRoot,
  stateFile,
  STALE_DAYS, DAY_MS,
  loadMemoryState, saveMemoryMeta, loadState, appendEvent, dayPrecision,
  rebuildIndex, collectMemoryFiles, parseFrontmatter,
  findAllScopes,
} from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const evictStale = process.argv.includes('--evict-stale');
const quiet = process.argv.includes('--quiet');
const now = Date.now();

function log(...args) {
  if (!quiet) console.log(...args);
}

// Load unified state
const state = loadState();
const lastPruneAt = state.prune.lastPruneAt || 0;

// Run scope-validate --fix first (ensures intermediate file integrity)
import { execFileSync } from "../shared/spawn.mjs";
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const validateScript = join(__dirname, 'scope-validate.mjs');
try {
  execFileSync('node', [validateScript, '--fix'], { cwd: scopeRoot, encoding: 'utf8', stdio: 'pipe' });
} catch { /* non-zero exit on unfixable issues — continue with prune */ }

// Build entry list from memory state + disk files
const memDir = join(scopeRoot, '.claude', 'memory');
const stateMap = loadMemoryState(scopeRoot);
const allMd = collectMemoryFiles(memDir);

const entries = [];
for (const absPath of allMd) {
  const relPath = absPath.replace(memDir, '').replace(/\\/g, '/').replace(/^\//, '');
  if (relPath.startsWith('tasks/')) continue;

  const meta = stateMap.get(relPath) || { accessed: '1970-01-01', count: 1, tier: 'short' };
  if (meta.dropped) continue;

  let title = relPath.split('/').pop().replace('.md', '');
  let type = null;
  try {
    const content = readFileSync(absPath, 'utf8');
    const { fields } = parseFrontmatter(content);
    if (fields.name) title = fields.name;
    // metadata.type is nested YAML — needs the structured parser, not the flat one
    type = parseNestedFrontmatter(content)?.metadata?.type || null;
  } catch { /* use defaults */ }

  entries.push({
    path: relPath,
    title,
    type,
    accessed: meta.accessed,
    accessedDate: new Date(meta.accessed).getTime(),
    tier: meta.tier || 'short',
    count: meta.count || 1,
  });
}

// Classify
const longTerm = entries.filter(e => e.tier === 'long');
const shortTerm = entries.filter(e => e.tier === 'short');

// ── Long-term demotion (classification only — mutations happen under the lock) ──
const demoted = [];
if (lastPruneAt > 0) {
  const lastPruneDay = dayPrecision(lastPruneAt);
  for (const e of longTerm) {
    if (e.accessedDate < lastPruneDay) {
      demoted.push(e);
    }
  }
}

if (demoted.length > 0) {
  log(`[prune-memory] ${demoted.length} long-term entries inactive since last prune → demoting to short:`);
  for (const e of demoted) {
    log(`  ${e.accessed} ${e.path}`);
    shortTerm.push(e);
    const idx = longTerm.indexOf(e);
    if (idx >= 0) longTerm.splice(idx, 1);
  }
}

// ── Short-term promotion, promote-first (before any stale eviction) ──
// A short already at the promotion threshold (count>=3 distinct-day accesses) is
// upgraded to long so it is protected this cycle. A long just demoted this run is
// excluded — its count resets to 1 at mutation, so it must re-earn promotion and
// is never ping-ponged long↔short within a single run.
const demotedSet = new Set(demoted.map(e => e.path));
const promoted = shortTerm.filter(e => e.count >= 3 && !demotedSet.has(e.path));
if (promoted.length > 0) {
  log(`[prune-memory] ${promoted.length} short-term entries at count>=3 → promoting to long:`);
  for (const e of promoted) {
    log(`  ${e.accessed} ${e.path} (accessed ${e.count}x)`);
    longTerm.push(e);
    const idx = shortTerm.indexOf(e);
    if (idx >= 0) shortTerm.splice(idx, 1);
  }
}

if (longTerm.length > 0) {
  log(`[prune-memory] ${longTerm.length} long-term entries (protected this cycle):`);
  for (const e of longTerm) log(`  ${e.accessed} ${e.path}`);
}

// ── Short-term stale eviction (time-based only — no count capacity cap) ──
// feedback entries are exempt from the 90-day stale eviction.
const stale = shortTerm.filter(e => now - e.accessedDate > STALE_DAYS * DAY_MS);
const staleEvictable = stale.filter(e => e.type !== 'feedback');
const staleExempt = stale.filter(e => e.type === 'feedback');
if (staleEvictable.length > 0) {
  log(`[prune-memory] ${staleEvictable.length} stale short-term entries (>${STALE_DAYS}d):`);
  for (const e of staleEvictable) {
    const days = Math.round((now - e.accessedDate) / DAY_MS);
    log(`  ${e.accessed} ${e.path} — last accessed ${days}d ago`);
  }
  if (evictStale && !dryRun) {
    log('[prune-memory] --evict-stale: dropping stale entries from index');
  }
}
if (staleExempt.length > 0) {
  log(`[prune-memory] ${staleExempt.length} stale feedback entries exempt from ${STALE_DAYS}d eviction (type: feedback):`);
  for (const e of staleExempt) log(`  ${e.accessed} ${e.path}`);
}

// Apply evictions — stale short-term only (dropped under --evict-stale).
const dropSet = new Set();
if (evictStale) staleEvictable.forEach(e => dropSet.add(e.path));

if (dryRun) {
  if (dropSet.size > 0 || demoted.length > 0 || promoted.length > 0) {
    log(`[prune-memory] --dry-run: would drop ${dropSet.size}, demote ${demoted.length}, promote ${promoted.length}`);
  } else {
    const total = longTerm.length + shortTerm.length;
    log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale`);
  }
} else {
  // Mutation phase (meta drops, state, index rebuilds) under a prune-wide lease
  // lock; the per-file locks inside saveState/saveMemoryMeta/rebuildIndex nest
  // safely (different lock paths). Fail-CLOSED (onTimeout: 'throw'): prune
  // --execute is a mutating CLI — running it without the lock would corrupt
  // shared state, unlike hooks which proceed best-effort.
  try {
  withLock(join(memDir, '.prune'), () => {
    for (const e of demoted) {
      saveMemoryMeta(scopeRoot, e.path, { tier: 'short', count: 1 }, { onTimeout: 'throw' });
      appendEvent('demote', { path: e.path, previousTier: 'long', reason: 'inactive between prune cycles' }, { onTimeout: 'throw' });
    }

    for (const e of promoted) {
      saveMemoryMeta(scopeRoot, e.path, { tier: 'long' }, { onTimeout: 'throw' });
      appendEvent('promote', { path: e.path, previousTier: 'short', reason: 'count >= 3 (promote-first)' }, { onTimeout: 'throw' });
    }

    // Load→mutate→save the prune timestamp atomically — a stale snapshot here
    // would clobber another process's concurrent state write (TOCTOU).
    withStateLock(stateFile, (fresh) => { fresh.prune.lastPruneAt = now; }, { onTimeout: 'throw' });

    for (const p of dropSet) {
      saveMemoryMeta(scopeRoot, p, { dropped: 'stale-90d' }, { onTimeout: 'throw' });
      appendEvent('evict', { path: p, reason: 'stale-90d' }, { onTimeout: 'throw' });
    }

    if (dropSet.size > 0 || demoted.length > 0 || promoted.length > 0) {
      const scopes = findAllScopes();
      for (const scope of scopes) {
        rebuildIndex(scope, { onTimeout: 'throw' });
      }
    }
  }, { onTimeout: 'throw' });
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') {
      console.error(`[prune-memory] another process holds the prune lock — refusing to run unlocked (${err.message})`);
      process.exit(1);
    }
    throw err;
  }

  if (dropSet.size === 0 && demoted.length === 0 && promoted.length === 0) {
    const total = longTerm.length + shortTerm.length;
    log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale`);
  } else {
    const kept = entries.length - dropSet.size;
    log(`[prune-memory] dropped ${dropSet.size}, demoted ${demoted.length}, promoted ${promoted.length}; ${kept} entries remaining`);
  }
}
