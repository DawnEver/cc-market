#!/usr/bin/env node
// diff-manifest.js — Analyze git diff and produce a review manifest.
// Outputs JSON to stdout. Called by the sharp-review skill before the workflow.
// Key invariant: maxBuffer 256MB on all git calls — default 1MB explodes on large diffs.

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  parseNumstatZ,
  parseNameStatusZ,
  buildManifest,
  decideMode,
  renderManifestText,
  extractHunkHeaders,
  INLINE_DIFF_LIMIT_DEFAULT,
} from '../lib.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_BUFFER = 256 * 1024 * 1024; // 256MB
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d9e1f93e4b1a';

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: 'pipe' });
}

function gitQuiet(args) {
  try { git(args); return true; } catch { return false; }
}

function gitOutput(args) {
  try { return git(args).trim(); } catch { return ''; }
}

// ── Range detection ──

function detectRange(rangeArg) {
  if (rangeArg) return rangeArg;

  const currentBranch = gitOutput(['branch', '--show-current']);

  if (gitQuiet(['rev-parse', '--verify', 'refs/heads/main']) && currentBranch !== 'main') {
    return 'main...HEAD';
  }
  if (gitQuiet(['rev-parse', '--verify', 'refs/heads/master']) && currentBranch !== 'master') {
    return 'master...HEAD';
  }
  if (gitQuiet(['rev-parse', '--verify', 'HEAD~1'])) {
    return 'HEAD~1..HEAD';
  }
  return `${EMPTY_TREE}..HEAD`;
}

// ── Config ──

function readLimit() {
  const stateFile = join(ROOT, '.claude', '.rem-state.json');
  if (!existsSync(stateFile)) return INLINE_DIFF_LIMIT_DEFAULT;
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    return state.reviewGate?.inlineDiffLimit ?? INLINE_DIFF_LIMIT_DEFAULT;
  } catch {
    return INLINE_DIFF_LIMIT_DEFAULT;
  }
}

// ── Diff filtering ──

function filterDiff(fullDiff, excludedPaths) {
  if (!excludedPaths.size) return fullDiff;
  const parts = fullDiff.split(/(?=^diff --git )/m);
  return parts.filter(part => {
    const m = part.match(/^diff --git a\/(.+) b\//m);
    return !m || !excludedPaths.has(m[1]);
  }).join('');
}

// ── Excluded summary ──

function excludedSummary(excluded) {
  const byReason = new Map();
  for (const e of excluded) {
    byReason.set(e.reason, (byReason.get(e.reason) || 0) + 1);
  }
  const parts = [];
  for (const [reason, count] of byReason) {
    parts.push(`${count} ${reason}`);
  }
  if (!parts.length) return '';
  return `${excluded.length} files excluded: ${parts.join(', ')}`;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const range = detectRange(getArg(args, '--range'));

  // Run all three git commands (avoid re-running git for each parse need)
  let numstatRaw, namestatusRaw, fullDiff;
  try {
    numstatRaw = git(['diff', '--numstat', '-z', '-M', range]);
  } catch {
    numstatRaw = '';
  }
  try {
    namestatusRaw = git(['diff', '--name-status', '-z', '-M', range]);
  } catch {
    namestatusRaw = '';
  }
  try {
    fullDiff = git(['diff', '-M', range]);
  } catch {
    fullDiff = '';
  }

  const numstat = parseNumstatZ(numstatRaw);
  const status = parseNameStatusZ(namestatusRaw);
  const hunksByPath = extractHunkHeaders(fullDiff);
  const { entries, excluded } = buildManifest(numstat, status, hunksByPath);

  // Filter full diff to remove excluded file segments
  const excludedPathSet = new Set(excluded.map(e => e.path));
  const filteredDiff = filterDiff(fullDiff, excludedPathSet);

  const filteredDiffChars = filteredDiff.length;
  const limit = readLimit();
  const mode = entries.length === 0 ? 'empty' : decideMode(filteredDiffChars, limit);

  const insertions = entries.reduce((s, e) => s + e.added, 0);
  const deletions = entries.reduce((s, e) => s + e.deleted, 0);

  const result = {
    mode,
    range,
    stats: {
      files: entries.length,
      insertions,
      deletions,
      excluded: excluded.length,
      diffChars: filteredDiffChars,
    },
    excludedSummary: excludedSummary(excluded),
  };

  if (mode === 'review') {
    result.diff = filteredDiff;
  } else if (mode === 'agent') {
    result.manifestText = renderManifestText(entries, { range });
  }
  // mode === 'empty': no diff or manifestText

  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
