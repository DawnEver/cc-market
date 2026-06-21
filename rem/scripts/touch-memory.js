#!/usr/bin/env node
// Update `accessed` timestamp on a memory entry (in _meta.json state).
// Usage: node scripts/touch-memory.js <relative-path> [--promote]
//   --promote  also change tier from short → long (frequently accessed memories)
//   e.g. node scripts/touch-memory.js 2026/06/03/takeover-plugin-v2.md --promote

import { existsSync } from 'fs';
import {
  todayISO, bumpAccessed, saveMemoryMeta, getMemoryMeta,
  rebuildIndex, findMemoryScope,
  resolveMemoryPath, isInsideMemoryDir,
} from './lib.mjs';

const args = process.argv.slice(2);
const promote = args.includes('--promote');
const target = args.find(a => !a.startsWith('--'));

if (!target) {
  console.error('Usage: node scripts/touch-memory.js <relative-path> [--promote]');
  process.exit(1);
}

const file = resolveMemoryPath(target);
if (!isInsideMemoryDir(file)) {
  console.error(`[touch-memory] path traversal denied: ${target}`);
  process.exit(1);
}

if (!existsSync(file)) {
  console.error(`[touch-memory] file not found: .claude/memory/${target}`);
  process.exit(1);
}

// Find which scope this file belongs to
const scope = findMemoryScope();
const relPath = target.replace(/\\/g, '/');

const today = todayISO();

// Check current state
const cur = getMemoryMeta(scope, relPath);
const oldDropped = cur.dropped;

// Bump accessed (touch clears dropped — re-indexes an evicted entry)
bumpAccessed(scope, relPath, today);

let action = oldDropped ? 're-indexed (was dropped) + bumped' : 'bumped';

if (promote) {
  saveMemoryMeta(scope, relPath, { tier: 'long' });
  if (cur.tier === 'long') {
    action = oldDropped ? 're-indexed + already long, bumped' : 'already long, bumped';
  } else {
    action = oldDropped ? 're-indexed + promoted to long + bumped' : 'promoted to long + bumped';
  }
}

// Rebuild index
rebuildIndex(scope);

console.log(`[touch-memory] ${target} → ${action}`);
