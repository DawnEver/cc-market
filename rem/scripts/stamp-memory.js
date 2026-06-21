#!/usr/bin/env node
// Initialize memory system for a project:
//   1. Create .claude/memory/ and .claude/rules/ dirs if missing
//   2. Run scope-validate --fix to ensure intermediate file integrity
//   3. Warn on memory files missing `name:` frontmatter
//   4. Rebuild MEMORY.md index (generated, gitignored)
// Idempotent — safe to run multiple times.

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { relative } from 'path';
import {
  scopeMemoryDir as memoryDir, scopeRulesDir as rulesDir,
  parseFrontmatter, collectMemoryFiles, rebuildIndex, findAllScopes,
} from './lib.mjs';

// Ensure directories exist
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

// Stamp: warn about files missing name: frontmatter
let warned = 0;
const allFiles = collectMemoryFiles(memoryDir);
for (const file of allFiles) {
  const relPath = relative(memoryDir, file).replace(/\\/g, '/');
  if (relPath.startsWith('tasks/')) continue;
  try {
    const content = readFileSync(file, 'utf8');
    const { fields } = parseFrontmatter(content);
    if (!fields.name) {
      console.warn(`[warn] no frontmatter name: ${relative(process.cwd(), file)}`);
      warned++;
    }
  } catch { /* skip unreadable */ }
}

// Rebuild index for all scopes
const scopes = findAllScopes();
for (const scope of scopes) {
  rebuildIndex(scope);
}

const scopeLabels = scopes.map(s => relative(process.cwd(), s).replace(/\\/g, '/') || '.').join(', ');
console.log(`[stamp-memory] ${allFiles.length} files, ${warned} warned, ${scopes.length} scope(s) indexed (${scopeLabels})`);
