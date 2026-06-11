#!/usr/bin/env node
// Compact orchestrator for the REM memory system.
//
//   node compact.js --check       → exit 0 if compact needed (≥20 entries), exit 1 otherwise
//   node compact.js --propose      → JSON listing of all indexed entries for user review
//   node compact.js --execute      → after model distilled rules into .claude/rules/rem/,
//                                    validate and clear the MEMORY.md index
//   node compact.js --validate     → check .claude/rules/rem/ namespace integrity
//
// Workflow:
//   1. Model runs --check; if exit 0 → compact needed
//   2. Model runs --propose → presents entry list to user for approval
//   3. Model reads approved memory files, distills to .claude/rules/rem/<topic>.md
//   4. Model runs --execute → validates rules exist, clears index, logs summary

import { SR_ID_RE } from '../shared/lib.mjs';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  scopeIndexFile as indexFile, remRulesDir, scopeMemoryDir as memoryDir,
  scopeRoot, MAX_ENTRIES, collectMemoryFiles,
  getMemoryMeta, getField, rebuildIndex, dropFromIndex,
} from '../lib.mjs';

const args = process.argv.slice(2);
const mode = args[0] || '--check';

// ── --check: is compact needed? ──
if (mode === '--check') {
  if (!existsSync(indexFile)) {
    console.log('[compact] MEMORY.md not found — nothing to compact');
    process.exit(1);
  }
  const content = readFileSync(indexFile, 'utf8');
  const entryCount = content.split('\n').filter(l => /^-\s+\[/.test(l)).length;
  if (entryCount >= MAX_ENTRIES) {
    console.log(`[compact] ${entryCount} entries (≥${MAX_ENTRIES}) — compact needed`);
    process.exit(0);
  }
  console.log(`[compact] ${entryCount} entries (<${MAX_ENTRIES}) — not needed`);
  process.exit(1);
}

// ── --propose: list all indexed entries for user review before compact ──
if (mode === '--propose') {
  if (!existsSync(indexFile)) {
    console.log(JSON.stringify({ entryCount: 0, maxEntries: MAX_ENTRIES, entries: [] }));
    process.exit(0);
  }
  const content = readFileSync(indexFile, 'utf8');

  // Extract paths from index
  const pathRe = /\]\(\.\.\/memory\/(.+?\.md)\)/g;
  const indexedPaths = [];
  let pm;
  while ((pm = pathRe.exec(content)) !== null) {
    indexedPaths.push(pm[1]);
  }

  const result = indexedPaths.map(p => {
    const memFile = join(memoryDir, p);
    const meta = getMemoryMeta(scopeRoot, p);
    let description = '';
    if (existsSync(memFile)) {
      try {
        description = getField(readFileSync(memFile, 'utf8'), 'description') || '';
      } catch { /* use defaults */ }
    }
    return {
      path: p,
      title: p.split('/').pop().replace('.md', ''),
      created: p.match(/(\d{4})\/(\d{2})\/(\d{2})/)?.slice(1).join('-') || '',
      accessed: meta.accessed,
      tier: meta.tier,
      accessCount: meta.count,
      description,
    };
  });

  console.log(JSON.stringify({
    entryCount: result.length,
    maxEntries: MAX_ENTRIES,
    overLimit: Math.max(0, result.length - MAX_ENTRIES),
    entries: result,
  }, null, 2));
  process.exit(0);
}

// ── --validate: check rem/ namespace integrity ──
if (mode === '--validate') {
  if (!existsSync(remRulesDir)) {
    console.log('[compact] .claude/rules/rem/ does not exist');
    process.exit(0);
  }

  const remFiles = readdirSync(remRulesDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name);

  if (remFiles.length === 0) {
    console.log('[compact] rem/ is empty — nothing to validate');
    process.exit(0);
  }

  console.log(`[compact] rem/ contains ${remFiles.length} rule(s):`);
  for (const f of remFiles) {
    const content = readFileSync(join(remRulesDir, f), 'utf8');
    const hasContent = content.trim().length > 0;
    console.log(`  ${hasContent ? '✓' : '!'} ${f} (${content.length}B)${hasContent ? '' : ' — empty file'}`);
  }
  process.exit(0);
}

// ── --execute: validate + clear index ──
if (mode === '--execute') {
  const distilledIdx = args.indexOf('--distilled');
  const distilledPaths = distilledIdx >= 0 && args[distilledIdx + 1]
    ? args[distilledIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : null;

  // 1. Ensure rem/ has at least one rule file
  if (!existsSync(remRulesDir)) {
    console.error('[compact] .claude/rules/rem/ not found — create it and add rule files first');
    process.exit(1);
  }
  const remFiles = readdirSync(remRulesDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'));
  if (remFiles.length === 0) {
    console.error('[compact] rem/ is empty — distill rules there before executing');
    process.exit(1);
  }
  console.log(`[compact] ${remFiles.length} rule(s) in rem/: ${remFiles.map(e => e.name).join(', ')}`);

  // 2. Verify no memory files were deleted (append-only rule)
  if (!existsSync(memoryDir)) {
    console.error('[compact] .claude/memory/ directory not found');
    process.exit(1);
  }
  const indexedPaths = [];
  const pathRe = /\]\(\.\.\/memory\/(.+?\.md)\)/g;
  let pm;
  while ((pm = pathRe.exec(readFileSync(indexFile, 'utf8'))) !== null) {
    indexedPaths.push(pm[1]);
  }
  const missing = indexedPaths.filter(p => !existsSync(join(memoryDir, p)));
  if (missing.length > 0) {
    console.error('[compact] append-only violation — indexed memory files deleted:');
    for (const p of missing) console.error(`  ${p}`);
    process.exit(1);
  }
  const memoryCount = collectMemoryFiles(memoryDir).length;
  console.log(`[compact] ${indexedPaths.length} indexed, ${memoryCount} total memory file(s)`);

  // 3. Apply drops
  if (!existsSync(indexFile)) {
    console.log('[compact] MEMORY.md not found');
    process.exit(0);
  }

  const pathsToDrop = distilledPaths || indexedPaths;

  if (distilledPaths && distilledPaths.length > 0) {
    // Granular mode: drop only distilled entries
    for (const p of distilledPaths) {
      dropFromIndex(scopeRoot, p, 'compacted');
    }
    console.log(`[compact] dropped ${distilledPaths.length}/${indexedPaths.length} distilled entries from index`);
  } else {
    // Full mode: drop all
    for (const p of indexedPaths) {
      dropFromIndex(scopeRoot, p, 'compacted');
    }
    console.log(`[compact] cleared ${indexedPaths.length} index entries`);
  }

  // 4. Rebuild index
  rebuildIndex(scopeRoot);

  // 5. Detect SR-ID findings being compacted
  const srIds = [];
  for (const p of pathsToDrop) {
    const memFile = join(memoryDir, p);
    if (!existsSync(memFile)) continue;
    try {
      const content = readFileSync(memFile, 'utf8');
      let m;
      while ((m = SR_ID_RE.exec(content)) !== null) {
        srIds.push(m[0]);
      }
    } catch { /* skip */ }
  }
  if (srIds.length > 0) {
    console.log(`[compact] ${srIds.length} SR finding(s) compacted into rules:`);
    console.log('  → Mark resolved: edit **Status:** OPEN → **Status:** FIXED in the memory file, then post-review --rescan');
  }

  console.log('[compact] done — memory consolidated into .claude/rules/rem/');
  process.exit(0);
}

// ── default ──
console.log('Usage: node compact.js [--check|--propose|--validate|--execute]');
process.exit(1);
