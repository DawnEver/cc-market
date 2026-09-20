#!/usr/bin/env node
// check-docs.js — detect doc staleness at crystallize time
// Project-agnostic: discovers doc files at all levels, checks uncommitted changes.

import { readdirSync, readFileSync } from 'fs';
import { execFileSync } from "../shared/spawn.mjs";
import { join, relative } from 'path';
import { repoRoot } from './lib.mjs';

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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which of the changed files a doc actually mentions.
 *
 * Matched by relative path, or by filename as a standalone token (`foo.js` inside "see
 * foo.js" counts for `scripts/foo.js`, but the `foo.js` inside `bar-foo.js` does not).
 */
export function referencedChanges(text, changedFiles) {
  const found = [];
  for (const changed of changedFiles) {
    const base = changed.split('/').pop();
    if (!base) continue;
    // A doc naming `scripts/check-docs.js` is talking about `rem/scripts/check-docs.js`.
    // Allowing a preceding slash is what makes a partial-path mention count; a preceding
    // word character, dot or hyphen still disqualifies it (`bar-check-docs.js` is a
    // different file).
    const asToken = new RegExp(`(^|[^\\w.-])${escapeRe(base)}($|[^\\w-])`);
    if (text.includes(changed) || asToken.test(text)) found.push(changed);
  }
  return found;
}

/**
 * Split docs into those edited in this change and those that REFERENCE something edited.
 *
 * The earlier criterion marked every doc that was not itself modified as "may be stale"
 * the moment anything changed. With a dozen docs in a repo that is a standing wall of
 * warnings on every crystallize, which is how a check stops being read — the same failure
 * as a checker that cries wolf anywhere else. A doc is now a candidate only when it
 * mentions a file that changed, and the report says which one.
 *
 * `readDoc` is injectable so this stays pure and testable; with no reader there is no
 * evidence either way, so nothing is reported rather than everything.
 */
export function crossReference(docFiles, changedFiles, readDoc = null) {
  const modifiedDocs = docFiles.filter(f => changedFiles.includes(f));
  const staleDocs = [];
  const staleBecause = {};

  for (const doc of docFiles) {
    if (changedFiles.includes(doc)) continue;
    if (!readDoc) continue;
    let text = '';
    try { text = readDoc(doc) ?? ''; } catch { continue; }
    const refs = referencedChanges(text, changedFiles);
    if (refs.length) {
      staleDocs.push(doc);
      staleBecause[doc] = refs;
    }
  }

  return { modifiedDocs, staleDocs, staleBecause, needsReview: staleDocs.length > 0 };
}

export function formatReport({ changedFiles, docFiles, modifiedDocs, staleDocs, staleBecause = {}, needsReview }) {
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
    let status = '';
    if (modifiedDocs.includes(f)) status = '✓ updated';
    else if (staleDocs.includes(f)) status = `— references ${(staleBecause[f] ?? []).slice(0, 3).join(', ')}`;
    lines.push(`    ${f} ${status}`.trimEnd());
  }
  if (needsReview) {
    lines.push(`\n  → ${staleDocs.length} doc(s) reference files that changed — review those, not all of them`);
  } else if (changedFiles.length === 0) {
    lines.push('  → Working tree clean — no doc review needed');
  } else {
    lines.push('  → No doc references anything that changed');
  }
  return lines.join('\n');
}

// ── CLI ──
function main() {
  const jsonMode = process.argv.includes('--json');
  const changedFiles = collectUncommitted(repoRoot);
  const docFiles = collectDocs(repoRoot, repoRoot, 0);
  const readDoc = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
  const { modifiedDocs, staleDocs, staleBecause, needsReview } = crossReference(docFiles, changedFiles, readDoc);

  if (jsonMode) {
    console.log(JSON.stringify({ needsReview, uncommitted: changedFiles.length, docFiles, modifiedDocs, staleDocs, staleBecause }));
  } else {
    console.log(formatReport({ changedFiles, docFiles, modifiedDocs, staleDocs, staleBecause, needsReview }));
  }

  process.exit(needsReview ? 1 : 0);
}

import { isMain } from '../shared/lib.mjs';
if (isMain(import.meta)) main();
