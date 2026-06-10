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
  scopeMemoryDir as memoryDir, scopeRulesDir as rulesDir, scopeIndexFile as indexFile,
  INDEX_HEADER,
  hasAllFields, stampMissingFields, parseFrontmatter,
  collectMemoryFiles, extractDateFromPath, parseIndexEntry, formatIndexEntry,
} from '../lib.mjs';

// Ensure directories exist
if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

// Create MEMORY.md index if missing
if (!existsSync(indexFile)) {
  writeFileSync(indexFile, INDEX_HEADER, 'utf8');
  console.log(`[stamp-memory] created ${relative(process.cwd(), indexFile)}`);
}

// Parse existing index entries and validate paths.
// Only well-formed entries (YYYY-MM-DD label via parseIndexEntry) are marked as indexed.
// Malformed entries like [2026 name] are treated as unindexed so they are
// re-added with the correct date format in this run.
let indexContent = readFileSync(indexFile, 'utf8');
const existingPaths = new Set();
const brokenPaths = new Set();
for (const line of indexContent.split('\n')) {
  const entry = parseIndexEntry(line);
  if (!entry) continue;
  if (existsSync(join(memoryDir, entry.path))) {
    existingPaths.add(entry.path);
  } else {
    brokenPaths.add(entry.path);
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

  // Check if in index (skip tasks/ — managed by task-engine, not memory)
  const relPath = relative(memoryDir, file).replace(/\\/g, '/');
  if (relPath.startsWith('tasks/')) continue;
  if (!existingPaths.has(relPath)) {
    // Re-read to get fresh stamped fields
    const fresh = readFileSync(file, 'utf8');
    const { fields: f } = parseFrontmatter(fresh);
    const date = extractDateFromPath(relPath);
    const name = f.name || relPath.split('/').pop().replace('.md', '');
    const created = f.created || date;
    const accessed = f.accessed || created;
    newFiles.push({ date, path: relPath, name, created, accessed });
  }
}

// Append new files to index — rebuild sorted by accessed
if (newFiles.length > 0) {
  const idxLines = readFileSync(indexFile, 'utf8').split('\n');

  // Collect existing well-formed entries using the shared parseIndexEntry/formatIndexEntry.
  // Malformed entries (e.g. [2026 name]) don't parse → are excluded here and dropped from
  // the rebuilt index, while their files appear in newFiles and get re-added correctly.
  const allEntries = [];
  for (const line of idxLines) {
    const e = parseIndexEntry(line);
    if (e) allEntries.push({ line: formatIndexEntry(e), accessed: e.accessed });
  }
  for (const f of newFiles) {
    const line = formatIndexEntry({ date: f.date, title: f.name, path: f.path, created: f.created, accessed: f.accessed });
    allEntries.push({ line, accessed: f.accessed });
  }
  allEntries.sort((a, b) => b.accessed.localeCompare(a.accessed));

  // Preserve all non-memory-entry lines (section headers, Tasks links, Scoped pointers, etc).
  // Only strip lines referencing date-structured paths (../memory/YYYY/MM/DD/) — not tasks links.
  // Also strip legacy ../memory/YYYY-MM-DD/ entries so they get rebuilt in nested form.
  const headerLines = idxLines.filter(l => !/\.\.\/memory\/\d{4}[\/-]\d{2}[\/-]\d{2}\//.test(l));
  const rebuilt = [...headerLines, ...allEntries.map(e => e.line)].join('\n') + '\n';
  writeFileSync(indexFile, rebuilt, 'utf8');
  console.log(`[stamp-memory] added ${newFiles.length} entries to index (globally sorted)`);
}

console.log(`[stamp-memory] ${updated} stamped, ${skipped} skipped, ${allFiles.length} total files`);
