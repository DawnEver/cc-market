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
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  indexFile, rulesDir, remRulesDir, memoryDir, INDEX_HEADER, MAX_ENTRIES, collectMemoryFiles,
  parseIndex, getTier, getAccessCount, getField,
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
  const { entries } = parseIndex(content);

  const result = entries.map(e => {
    const memFile = join(memoryDir, e.path);
    let tier = 'short';
    let accessCount = 1;
    let description = '';
    if (existsSync(memFile)) {
      try {
        const memContent = readFileSync(memFile, 'utf8');
        tier = getTier(memContent);
        accessCount = getAccessCount(memContent);
        description = getField(memContent, 'description') || '';
      } catch { /* use defaults */ }
    }
    return {
      path: e.path,
      title: e.title,
      created: e.created,
      accessed: e.accessed,
      tier,
      accessCount,
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
  // Parse --distilled <path1,path2,...>
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
  // Baseline: every path referenced in the index must still exist on disk
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

  // 3. Count entries before clear
  if (!existsSync(indexFile)) {
    console.log('[compact] MEMORY.md not found');
    process.exit(0);
  }
  const content = readFileSync(indexFile, 'utf8');
  const allLines = content.split('\n');
  const entryLines = allLines.filter(l => /^-\s+\[/.test(l));

  // 4. Clear index entries
  if (distilledPaths && distilledPaths.length > 0) {
    // Granular mode: only remove entries that were distilled
    const keepLines = [];
    let removed = 0;
    for (const line of entryLines) {
      const pathMatch = line.match(/\]\(\.\.\/memory\/(.+?\.md)\)/);
      if (pathMatch && distilledPaths.includes(pathMatch[1])) {
        removed++;
      } else {
        keepLines.push(line);
      }
    }
    if (removed === 0) {
      console.log('[compact] --distilled paths matched no index entries — nothing removed');
      console.log(`  distilled: ${distilledPaths.join(', ')}`);
      process.exit(0);
    }
    // Rebuild: header + undistilled entries
    const headerLines = allLines.filter(l => !/^-\s+\[/.test(l));
    writeFileSync(indexFile, [...headerLines, ...keepLines].join('\n') + '\n', 'utf8');
    console.log(`[compact] removed ${removed}/${entryLines.length} distilled entries, ${keepLines.length} kept`);
  } else {
    // Full mode: clear all entries (keep unified INDEX_HEADER)
    writeFileSync(indexFile, INDEX_HEADER, 'utf8');
    console.log(`[compact] cleared ${entryLines.length} index entries → MEMORY.md reset`);
  }
  // 5. Detect SR-ID findings being compacted → suggest resolution
  const pathsToCheck = distilledPaths || indexedPaths;
  const srIds = [];
  for (const p of pathsToCheck) {
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
    console.log(`  → Mark resolved: edit **Status:** OPEN → **Status:** FIXED in the memory file, then post-review --rescan`);
  }

  console.log('[compact] done — memory consolidated into .claude/rules/rem/');
  process.exit(0);
}

// ── default ──
console.log('Usage: node compact.js [--check|--propose|--validate|--execute]');
process.exit(1);
