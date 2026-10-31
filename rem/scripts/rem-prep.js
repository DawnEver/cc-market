#!/usr/bin/env node
// REM preparation — read-only report that runs before the /rem skill:
//   1. Memory entries this session read (from the transcript) — the candidates to
//      merge into, supersede, or crystallize, since they are what the session used.
//   2. Per scope: visible entries, entries hidden by a newer entry's `merged_from`
//      (kept on disk), and the crystallize advisory.
// It never writes: reading memory leaves no trace in the tree or in any state file.
//
// Usage: node rem-prep.js [--transcript <path>]

import { readFileSync, existsSync } from 'fs';
import { relative } from 'path';
import { normalizeHookFacts } from '../shared/hook-facts.mjs';
import { findAllScopes, listEntries, hiddenEntries, CRYSTALLIZE_ADVISORY } from './lib.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--transcript');
const transcriptPath = at >= 0 ? args[at + 1] : null;

export function memoryReads(lines) {
  const read = new Set();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    for (const fp of normalizeHookFacts([entry]).readPaths) {
      const rel = fp.replace(/\\/g, '/');
      const i = rel.indexOf('.claude/memory/');
      if (i >= 0) read.add(rel.slice(i + '.claude/memory/'.length));
    }
  }
  return [...read].sort();
}

console.log('─── Memory entries read this session ───');
const reads = transcriptPath && existsSync(transcriptPath)
  ? memoryReads(readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean))
  : [];
if (!reads.length) console.log('  (none)');
for (const p of reads) console.log(`  ${p}`);

console.log('\n─── Scopes ───');
for (const scope of findAllScopes()) {
  const entries = listEntries(scope);
  const hidden = hiddenEntries(entries);
  const live = entries.length - hidden.size;
  const label = relative(process.cwd(), scope).replace(/\\/g, '/') || '.';
  const advice = live >= CRYSTALLIZE_ADVISORY ? ' — crystallize recommended' : '';
  console.log(`  ${label}: ${live} visible, ${hidden.size} hidden${advice}`);
}

console.log('\n[rem-prep] done');
