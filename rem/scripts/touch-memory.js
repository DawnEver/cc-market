#!/usr/bin/env node
// Update `accessed` timestamp on a memory file AND its index entry.
// Usage: node scripts/touch-memory.js <relative-path> [--promote]
//   --promote  also change tier from short → long (frequently accessed memories)
//   e.g. node scripts/touch-memory.js 2026-06-03/takeover-plugin-v2.md --promote

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  memoryDir, indexFile, todayISO, bumpAccessed, setField, updateIndexAccessed,
  resolveMemoryPath, isInsideMemoryDir,
} from '../lib.mjs';

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

// Update memory file
let content;
try { content = readFileSync(file, 'utf8'); } catch {
  console.error(`[touch-memory] file not found: .claude/memory/${target}`);
  console.error('  Run: node ${CLAUDE_PLUGIN_ROOT}/scripts/stamp-memory.js');
  process.exit(1);
}

const today = todayISO();
let updated = bumpAccessed(content, today);
if (!updated) {
  console.error(`[touch-memory] no 'accessed:' field in ${target}`);
  console.error('  Run: node ${CLAUDE_PLUGIN_ROOT}/scripts/stamp-memory.js');
  process.exit(1);
}

let action = 'bumped';
if (promote) {
  const tierReplaced = setField(updated, 'tier', 'long');
  if (tierReplaced !== updated) {
    updated = tierReplaced;
    action = 'promoted to long + bumped';
  } else if (/^tier: long$/m.test(updated)) {
    action = 'already long, bumped';
  }
}
writeFileSync(file, updated, 'utf8');

// Update index entry
if (existsSync(indexFile)) {
  let idx = readFileSync(indexFile, 'utf8');
  const newIdx = updateIndexAccessed(idx, target, today);
  if (newIdx !== null) {
    if (newIdx !== idx) writeFileSync(indexFile, newIdx, 'utf8');
    console.log(`[touch-memory] ${target} → ${action} (file + index)`);
  } else {
    console.warn(`[touch-memory] ${target} → ${action} (file only, index entry not found — may need manual update)`);
  }
} else {
  console.log(`[touch-memory] ${target} → ${action} (no index yet, run stamp-memory.js)`);
}
