#!/usr/bin/env node
// Initialize memory system for a project:
//   1. Create .claude/memory/ and .claude/rules/ dirs if missing
//   2. Create .claude/rules/MEMORY.md index if missing
//   3. Add `created`/`accessed`/`tier` timestamps to all memory files
//   4. Scan and auto-add unlisted memory files to the index
// Idempotent — safe to run multiple times.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import {
  memoryDir, rulesDir, indexFile, INDEX_HEADER,
  hasAllFields, stampMissingFields, parseFrontmatter,
  collectMemoryFiles, todayISO, extractDateFromPath,
} from '../lib.mjs';

// Ensure directories exist
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

// Create MEMORY.md index if missing
if (!existsSync(indexFile)) {
  writeFileSync(indexFile, INDEX_HEADER, 'utf8');
  console.log(`[stamp-memory] created ${relative(process.cwd(), indexFile)}`);
}

// Parse existing index entries and validate paths
let indexContent = readFileSync(indexFile, 'utf8');
const existingPaths = new Set();
const brokenPaths = new Set();
const entryPattern = /\]\(\.\.\/memory\/(.+?\.md)\)/g;
let m;
while ((m = entryPattern.exec(indexContent)) !== null) {
  const rel = m[1];
  if (existsSync(join(memoryDir, rel))) {
    existingPaths.add(rel);
  } else {
    brokenPaths.add(rel);
  }
}

// Remove broken entries from index
if (brokenPaths.size > 0) {
  const lines = indexContent.split('\n');
  const kept = lines.filter(l => {
    const em = l.match(/\]\(\.\.\/memory\/(.+?\.md)\)/);
    return !em || !brokenPaths.has(em[1]);
  });
  indexContent = kept.join('\n');
  writeFileSync(indexFile, indexContent, 'utf8');
  console.log(`[stamp-memory] removed ${brokenPaths.size} broken entries from index`);
}

// Stamp memory files
let updated = 0;
let skipped = 0;
const newFiles = [];

const allFiles = collectMemoryFiles(memoryDir);
for (const file of allFiles) {
  const content = readFileSync(file, 'utf8');
  const { fields } = parseFrontmatter(content);
  if (!fields.name) {
    console.warn(`[warn] no frontmatter: ${relative(process.cwd(), file)}`);
    continue;
  }

  if (hasAllFields(content)) {
    skipped++;
  } else {
    stampMissingFields(file);
    updated++;
  }

  // Check if in index
  const relPath = relative(memoryDir, file).replace(/\\/g, '/');
  if (!existingPaths.has(relPath)) {
    // Re-read to get fresh stamped fields
    const fresh = readFileSync(file, 'utf8');
    const { fields: f } = parseFrontmatter(fresh);
    const date = relPath.split('/')[0];
    const name = f.name || relPath.split('/').pop().replace('.md', '');
    const created = f.created || date;
    const accessed = f.accessed || created;
    newFiles.push({ date, path: relPath, name, created, accessed });
  }
}

// Append new files to index — rebuild sorted by accessed
if (newFiles.length > 0) {
  // Collect existing entries with accessed date for sorting
  const entryRe = /^-\s+\[\d{4}-\d{2}-\d{2}\s+.+\]\(\.\.\/memory\/(.+?\.md)\)\s*—\s*`created:\s*\d{4}-\d{2}-\d{2},\s*accessed:\s*(\d{4}-\d{2}-\d{2})`/;
  const allEntries = [];
  const idxLines = readFileSync(indexFile, 'utf8').split('\n');
  for (const line of idxLines) {
    const m = line.match(entryRe);
    if (m) {
      allEntries.push({ line, accessed: m[2] });
    }
  }
  for (const f of newFiles) {
    const line = `- [${f.date} ${f.name}](../memory/${f.path}) — \`created: ${f.created}, accessed: ${f.accessed}\``;
    allEntries.push({ line, accessed: f.accessed });
  }
  allEntries.sort((a, b) => b.accessed.localeCompare(a.accessed));

  // Rebuild: header lines + sorted entries
  const headerLines = idxLines.filter(l => !/^-\s+\[/.test(l));
  const rebuilt = [...headerLines, ...allEntries.map(e => e.line)].join('\n') + '\n';
  writeFileSync(indexFile, rebuilt, 'utf8');
  console.log(`[stamp-memory] added ${newFiles.length} entries to index (globally sorted)`);
}

console.log(`[stamp-memory] ${updated} stamped, ${skipped} skipped, ${allFiles.length} total files`);
