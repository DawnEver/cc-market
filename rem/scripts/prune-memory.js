#!/usr/bin/env node
// Prune MEMORY.md index:
//   - Short-term (>90d stale or >20 count): evict from index
//   - Long-term (not accessed since last prune): demote to short
// Run: node scripts/prune-memory.js [--dry-run] [--evict-stale]
// If MEMORY.md doesn't exist, exit — run stamp-memory.js first to initialize.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  scopeMemoryDir as memoryDir, scopeIndexFile as indexFile, scopeRoot,
  MAX_ENTRIES, STALE_DAYS, DAY_MS,
  getTier, setTier, parseIndex, loadState, saveState, appendEvent, dayPrecision,
} from '../lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const evictStale = process.argv.includes('--evict-stale');
const now = Date.now();

// Load unified state
const state = loadState();
const lastPruneAt = state.prune.lastPruneAt || 0;

if (!existsSync(indexFile)) {
  console.log('[prune-memory] MEMORY.md not found — run stamp-memory.js first to initialize');
  process.exit(0);
}

// Parse index
const content = readFileSync(indexFile, 'utf8');
const { header, entries } = parseIndex(content);

// Resolve tier from memory file frontmatter
const resolveTier = (entry) => {
  try {
    const memContent = readFileSync(join(memoryDir, entry.path), 'utf8');
    return getTier(memContent);
  } catch { return 'short'; }
};

const writeTier = (entry, tier) => {
  const memFile = join(memoryDir, entry.path);
  let c = readFileSync(memFile, 'utf8');
  c = setTier(c, tier);
  writeFileSync(memFile, c, 'utf8');
};

// Classify entries
const longTerm = [];
const shortTerm = [];
for (const e of entries) {
  (resolveTier(e) === 'long' ? longTerm : shortTerm).push(e);
}

// ── Long-term demotion ──
// Demote if not accessed since last prune (needs 2 prune cycles to fully evict)
// Compare at day precision to avoid demoting entries accessed same-day as prune
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
    console.log(`  ${e.date} ${e.path}`);
    if (!dryRun) {
      writeTier(e, 'short');
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
  for (const e of longTerm) console.log(`  ${e.date} ${e.path}`);
}

// ── Short-term eviction ──

// Check stale (short-term only, >90d since last access)
const stale = shortTerm.filter(e => now - e.accessedDate > STALE_DAYS * DAY_MS);
if (stale.length > 0) {
  console.log(`[prune-memory] ${stale.length} stale short-term entries (>${STALE_DAYS}d):`);
  for (const e of stale) {
    const days = Math.round((now - e.accessedDate) / DAY_MS);
    console.log(`  ${e.date} ${e.path} — last accessed ${days}d ago`);
  }
  if (evictStale && !dryRun) {
    console.log('[prune-memory] --evict-stale: removing stale entries from index');
  }
}

// Check count (short-term only)
const over = shortTerm.length - MAX_ENTRIES;
if (over > 0) {
  // Sort oldest-first for eviction (index is newest-first)
  const oldestFirst = [...shortTerm].sort((a, b) => a.accessedDate - b.accessedDate);
  const toDrop = oldestFirst.slice(0, over);
  console.log(`[prune-memory] ${shortTerm.length} short-term entries, dropping ${over} oldest:`);
  for (const e of toDrop) {
    console.log(`  ${e.date} ${e.path}`);
  }
}

// Build new index
const removeLines = new Set();
if (evictStale) stale.forEach(e => removeLines.add(e.line));
if (over > 0) {
  const oldestFirst = [...shortTerm].sort((a, b) => a.accessedDate - b.accessedDate);
  oldestFirst.slice(0, over).forEach(e => removeLines.add(e.line));
}

// Update prune stamp
if (!dryRun) {
  state.prune.lastPruneAt = now;
  saveState(state);
}

if (removeLines.size === 0 && demoted.length === 0) {
  const total = longTerm.length + shortTerm.length;
  console.log(`[prune-memory] ${total} total (${longTerm.length} long, ${shortTerm.length} short), ${stale.length} stale, ${over > 0 ? over : 0} over limit`);
  process.exit(0);
}

const keptEntries = entries.filter(e => !removeLines.has(e.line));
const newContent = [...header, ...keptEntries.map(e => e.line)].join('\n') + '\n';

if (dryRun) {
  console.log('[prune-memory] --dry-run: would write:');
  console.log(newContent);
} else {
  writeFileSync(indexFile, newContent, 'utf8');
  // Log evicted entries
  for (const e of entries) {
    if (removeLines.has(e.line)) {
      appendEvent('evict', { path: e.path, reason: stale.includes(e) ? 'stale-90d' : 'over-capacity' });
    }
  }
  console.log(`[prune-memory] removed ${removeLines.size} entries, ${keptEntries.length} remaining`);
}
