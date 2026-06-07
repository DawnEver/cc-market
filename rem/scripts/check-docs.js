#!/usr/bin/env node
// check-docs.js — detect doc staleness at compact time
// Project-agnostic: discovers doc files at all levels, checks uncommitted changes.

import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { repoRoot } from '../lib.mjs';

export const DOC_PATTERN = /^(README|CLAUDE|AGENTS|AGENT|CHANGELOG|CONTRIBUTING).*\.md$/i;
export const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'build', '__pycache__', '.venv', 'venv']);

export function collectDocs(root, dir, depth) {
  if (depth > 4) return [];
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        results.push(...collectDocs(root, join(dir, name), depth + 1));
      } else if (entry.isFile() && DOC_PATTERN.test(name)) {
        results.push(relative(root, join(dir, name)).replace(/\\/g, '/'));
      }
    }
  } catch { /* permissions */ }
  return results;
}

export function collectUncommitted(cwd) {
  const files = [];
  try {
    const diff = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd, timeout: 3000, encoding: 'utf8',
    });
    files.push(...diff.trim().split('\n').filter(Boolean));
  } catch { /* not a git repo */ }
  try {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd, timeout: 3000, encoding: 'utf8',
    });
    files.push(...untracked.trim().split('\n').filter(Boolean));
  } catch { /* not a git repo */ }
  return [...new Set(files)];
}

export function crossReference(docFiles, changedFiles) {
  const modifiedDocs = docFiles.filter(f => changedFiles.includes(f));
  const staleDocs = docFiles.filter(f => !changedFiles.includes(f));
  const needsReview = changedFiles.length > 0 && staleDocs.length > 0;
  return { modifiedDocs, staleDocs, needsReview };
}

export function formatReport({ changedFiles, docFiles, modifiedDocs, staleDocs, needsReview }) {
  const lines = [];
  lines.push('─── Doc freshness check ───');
  if (changedFiles.length === 0) {
    lines.push('  No uncommitted changes — working tree clean');
    lines.push(`  Doc files (${docFiles.length}):`);
  } else {
    lines.push(`  Uncommitted changes: ${changedFiles.length} files`);
    lines.push(`  Doc files (${docFiles.length}):`);
  }
  for (const f of docFiles) {
    const status = modifiedDocs.includes(f) ? '✓ updated' : (changedFiles.length > 0 ? '— may be stale' : '');
    lines.push(`    ${f} ${status}`);
  }
  if (needsReview) {
    lines.push(`\n  → Uncommitted changes detected — review doc files marked "may be stale"`);
  } else if (changedFiles.length === 0) {
    lines.push('  → Working tree clean — no doc review needed');
  } else {
    lines.push('  → All docs already updated');
  }
  return lines.join('\n');
}

// ── CLI ──
function main() {
  const jsonMode = process.argv.includes('--json');
  const changedFiles = collectUncommitted(repoRoot);
  const docFiles = collectDocs(repoRoot, repoRoot, 0);
  const { modifiedDocs, staleDocs, needsReview } = crossReference(docFiles, changedFiles);

  if (jsonMode) {
    console.log(JSON.stringify({ needsReview, uncommitted: changedFiles.length, docFiles, modifiedDocs, staleDocs }));
  } else {
    console.log(formatReport({ changedFiles, docFiles, modifiedDocs, staleDocs, needsReview }));
  }

  process.exit(needsReview ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) main();
