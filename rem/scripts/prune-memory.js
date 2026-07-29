#!/usr/bin/env node
// Prune MEMORY.md index:
//   - Short-term (>90d stale or >20 count): evict from index
//     (entries with frontmatter `metadata.type: feedback` are exempt from the
//     90-day stale eviction — explicit user corrections have long-term value —
//     but still count toward and can be dropped by the capacity cap)
//   - Long-term (not accessed since last prune): demote to short
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
  MAX_ENTRIES, STALE_DAYS, DAY_MS,
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

if (longTerm.length > 0) {
  log(`[prune-memory] ${longTerm.length} long-term entries (protected this cycle):`);
  for (const e of longTerm) log(`  ${e.accessed} ${e.path}`);
}

// ── Short-term eviction ──
// feedback entries are exempt from the 90-day stale eviction, never from the cap.
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

const over = shortTerm.length - MAX_ENTRIES;
const toDrop = over > 0
  ? [...shortTerm].sort((a, b) => a.accessedDate - b.accessedDate).slice(0, over)
  : [];
if (over > 0) {
  log(`[prune-memory] ${shortTerm.length} short-term entries, dropping ${over} oldest:`);
  for (const e of toDrop) {
    log(`  ${e.accessed} ${e.path}`);
  }
}

// Apply evictions
const dropSet = new Set();
if (evictStale) staleEvictable.forEach(e => dropSet.add(e.path));
toDrop.forEach(e => dropSet.add(e.path));

if (dryRun) {
  if (dropSet.size > 0 || demoted.length > 0) {
    log('[prune-memory] --dry-run: would drop ' + dropSet.size + ' entries');
  } else {
    const total = longTerm.length + shortTerm.length;
    log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale, ${over > 0 ? over : 0} over limit`);
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

    // Load→mutate→save the prune timestamp atomically — a stale snapshot here
    // would clobber another process's concurrent state write (TOCTOU).
    withStateLock(stateFile, (fresh) => { fresh.prune.lastPruneAt = now; }, { onTimeout: 'throw' });

    for (const p of dropSet) {
      const reason = staleEvictable.some(e => e.path === p) ? 'stale-90d' : 'over-capacity';
      saveMemoryMeta(scopeRoot, p, { dropped: reason }, { onTimeout: 'throw' });
      appendEvent('evict', { path: p, reason }, { onTimeout: 'throw' });
    }

    if (dropSet.size > 0 || demoted.length > 0) {
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

  if (dropSet.size === 0 && demoted.length === 0) {
    const total = longTerm.length + shortTerm.length;
    log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale, ${over > 0 ? over : 0} over limit`);
  } else {
    const kept = entries.length - dropSet.size;
    log(`[prune-memory] removed ${dropSet.size} entries, ${kept} remaining`);
  }
}
