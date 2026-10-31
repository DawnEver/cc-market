#!/usr/bin/env node
// Regenerate every scope's .claude/rules/MEMORY.md from its memory tree.
// SessionStart hook and CLI. Lock-free and idempotent: the index is a pure
// function of the tree and is written only when its bytes change.
//
//   node index-memory.js [--quiet]

import { existsSync, mkdirSync } from 'fs';
import { relative } from 'path';
import { findAllScopes, rebuildIndex, scopeMemoryDir } from './lib.mjs';

const quiet = process.argv.includes('--quiet');
if (!quiet && !existsSync(scopeMemoryDir)) mkdirSync(scopeMemoryDir, { recursive: true });
const written = [];
for (const scope of findAllScopes()) if (rebuildIndex(scope)) written.push(scope);
if (!quiet) {
  const names = written.map(s => relative(process.cwd(), s).replace(/\\/g, '/') || '.');
  console.log(`[index-memory] ${written.length} index(es) changed${names.length ? `: ${names.join(', ')}` : ''}`);
}
