#!/usr/bin/env node
// Prune MEMORY.md index:
//   - Short-term (>90d stale or >20 count): evict from index
//   - Long-term (not accessed since last prune): demote to short
// Run: node scripts/prune-memory.js [--dry-run] [--evict-stale]
// Called by SessionStart hook; runs scope-validate --fix first.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scopeRoot,
  MAX_ENTRIES, STALE_DAYS, DAY_MS,
  loadMemoryState, saveMemoryMeta, loadState, saveState, appendEvent, dayPrecision,
  rebuildIndex, collectMemoryFiles, parseFrontmatter,
  findAllScopes,
} from '../lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const evictStale = process.argv.includes('--evict-stale');
const now = Date.now();

// Load unified state
const state = loadState();
const lastPruneAt = state.prune.lastPruneAt || 0;

// Run scope-validate --fix first (ensures intermediate file integrity)
import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const validateScript = join(__dirname, 'scope-validate.mjs');
try {
  execFileSync('node', [validateScript, '--fix'], { cwd: scopeRoot, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
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
  try {
    const { fields } = parseFrontmatter(readFileSync(absPath, 'utf8'));
    if (fields.name) title = fields.name;
  } catch { /* use defaults */ }

  entries.push({
    path: relPath,
    title,
    accessed: meta.accessed,
    accessedDate: new Date(meta.accessed).getTime(),
    tier: meta.tier || 'short',
    count: meta.count || 1,
  });
}

// Classify
const longTerm = entries.filter(e => e.tier === 'long');
const shortTerm = entries.filter(e => e.tier === 'short');

// ── Long-term demotion ──
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
  console.log(`[prune-memory] ${demoted.length} long-term entries inactive since last prune → demoting to short:`);
  for (const e of demoted) {
    console.log(`  ${e.accessed} ${e.path}`);
    if (!dryRun) {
      saveMemoryMeta(scopeRoot, e.path, { tier: 'short', count: 1 });
      shortTerm.push(e);
      appendEvent('demote', { path: e.path, previousTier: 'long', reason: 'inactive between prune cycles' });
    }
  }
  for (const e of demoted) {
    const idx = longTerm.indexOf(e);
    if (idx >= 0) longTerm.splice(idx, 1);
  }
}

if (longTerm.length > 0) {
  console.log(`[prune-memory] ${longTerm.length} long-term entries (protected this cycle):`);
  for (const e of longTerm) console.log(`  ${e.accessed} ${e.path}`);
}

// ── Short-term eviction ──
const stale = shortTerm.filter(e => now - e.accessedDate > STALE_DAYS * DAY_MS);
if (stale.length > 0) {
  console.log(`[prune-memory] ${stale.length} stale short-term entries (>${STALE_DAYS}d):`);
  for (const e of stale) {
    const days = Math.round((now - e.accessedDate) / DAY_MS);
    console.log(`  ${e.accessed} ${e.path} — last accessed ${days}d ago`);
  }
  if (evictStale && !dryRun) {
    console.log('[prune-memory] --evict-stale: dropping stale entries from index');
  }
}

const over = shortTerm.length - MAX_ENTRIES;
if (over > 0) {
  const oldestFirst = [...shortTerm].sort((a, b) => a.accessedDate - b.accessedDate);
  const toDrop = oldestFirst.slice(0, over);
  console.log(`[prune-memory] ${shortTerm.length} short-term entries, dropping ${over} oldest:`);
  for (const e of toDrop) {
    console.log(`  ${e.accessed} ${e.path}`);
  }
}

// Apply evictions
const dropSet = new Set();
if (evictStale) stale.forEach(e => dropSet.add(e.path));
if (over > 0) {
  const oldestFirst = [...shortTerm].sort((a, b) => a.accessedDate - b.accessedDate);
  oldestFirst.slice(0, over).forEach(e => dropSet.add(e.path));
}

if (!dryRun) {
  state.prune.lastPruneAt = now;
  saveState(state);

  for (const p of dropSet) {
    appendEvent('evict', { path: p, reason: stale.find(e => e.path === p) ? 'stale-90d' : 'over-capacity' });
  }
}

if (dropSet.size === 0 && demoted.length === 0) {
  const total = longTerm.length + shortTerm.length;
  console.log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale, ${over > 0 ? over : 0} over limit`);
} else if (dryRun) {
  console.log('[prune-memory] --dry-run: would drop ' + dropSet.size + ' entries');
} else {
  // Drop entries from state
  for (const p of dropSet) {
    saveMemoryMeta(scopeRoot, p, { dropped: evictStale ? 'stale-90d' : 'over-capacity' });
  }

  // Rebuild index for all scopes
  const scopes = findAllScopes();
  for (const scope of scopes) {
    rebuildIndex(scope);
  }

  const kept = entries.length - dropSet.size;
  console.log(`[prune-memory] removed ${dropSet.size} entries, ${kept} remaining`);
}
