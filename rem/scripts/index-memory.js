#!/usr/bin/env node
// Derive every scope's .claude/memory-index.md from its memory tree. Lock-free and
// idempotent: the index is a pure function of the tree (byte-identical on every
// machine) and is written only when its bytes change. No hook runs this; writers
// (remember, merge-memory, crystallize) and /rem do.
//
//   node index-memory.js [--quiet]   write changed indexes for every scope
//   node index-memory.js --print     print the root's index, write nothing

import { relative } from 'path';
import { findAllScopes, rebuildIndex, renderIndex, memoryRoot } from './lib.mjs';

if (process.argv.includes('--print')) {
  process.stdout.write(renderIndex(memoryRoot()));
} else {
  const written = findAllScopes().filter(scope => rebuildIndex(scope));
  if (!process.argv.includes('--quiet')) {
    const names = written.map(s => relative(process.cwd(), s).replace(/\\/g, '/') || '.');
    console.log(`[index-memory] ${written.length} index(es) changed${names.length ? `: ${names.join(', ')}` : ''}`);
  }
}
