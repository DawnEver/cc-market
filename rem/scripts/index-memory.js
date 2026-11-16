#!/usr/bin/env node
// Derive the root's .claude/memory-index.md from its memory tree. Lock-free and idempotent: the
// index is a pure function of the tree (byte-identical on every machine) and is written only
// when its bytes change. No hook runs this; writers (remember, merge-memory, crystallize) and /rem do.
//
//   node index-memory.js [--quiet]   write the index when it changed
//   node index-memory.js --print     print the index, write nothing

import { rebuildIndex, renderIndex, memoryRoot } from './lib.mjs';

if (process.argv.includes('--print')) {
  process.stdout.write(renderIndex(memoryRoot()));
} else {
  const written = rebuildIndex(memoryRoot());
  if (!process.argv.includes('--quiet')) console.log(`[index-memory] ${written ? 1 : 0} index(es) changed${written ? ': .' : ''}`);
}
