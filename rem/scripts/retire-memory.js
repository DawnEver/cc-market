#!/usr/bin/env node
// Retire memory entries: delete every entry a live entry names in `merged_from:`.
// That naming is the whole lifecycle — merge-memory.js, remember.js (supersede) and
// crystallize.js write it; this deletes what it names. Content survives in the
// naming entry (or the rule it points at) and in git history.
//
//   node retire-memory.js            → dry run: list what would be deleted, per scope
//   node retire-memory.js --execute  → delete them and regenerate each scope's index

import { relative } from 'path';
import { findAllScopes, retireMemory, rebuildIndex } from './lib.mjs';

const execute = process.argv.includes('--execute');
let total = 0;
for (const scope of findAllScopes()) {
  const retired = retireMemory(scope, { dryRun: !execute });
  if (!retired.size) continue;
  total += retired.size;
  const label = relative(process.cwd(), scope).replace(/\\/g, '/') || '.';
  console.log(`${label}: ${retired.size} ${execute ? 'retired' : 'to retire'}`);
  for (const [p, by] of retired) console.log(`  ${p}  ← ${by}`);
  if (execute) rebuildIndex(scope);
}
console.log(`[retire-memory] ${total} entr${total === 1 ? 'y' : 'ies'} ${execute ? 'deleted' : 'would be deleted (dry run; --execute to delete)'}`);
