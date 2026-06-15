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
  decideManifestMode,
  renderManifestText,
  extractHunkHeaders,
  filterDiff,
  INLINE_DIFF_LIMIT_DEFAULT,
} from '../lib.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MAX_BUFFER = 256 * 1024 * 1024; // 256MB
function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: 'pipe' });
}

// ── Range detection ──

function detectRange(rangeArg) {
  if (rangeArg) return rangeArg;
  // Default: uncommitted changes (staged + unstaged vs HEAD)
  return 'HEAD';
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
  const subPath = getArg(args, '--path');

  // Build base args: git diff <flags> <range> [-- <path>]
  const baseArgs = ['-M', range];
  if (subPath) baseArgs.push('--', subPath);

  // Run all three git commands (avoid re-running git for each parse need)
  let numstatRaw, namestatusRaw, fullDiff;
  try {
    numstatRaw = git(['diff', '--numstat', '-z', ...baseArgs]);
  } catch {
    numstatRaw = '';
  }
  try {
    namestatusRaw = git(['diff', '--name-status', '-z', ...baseArgs]);
  } catch {
    namestatusRaw = '';
  }
  try {
    fullDiff = git(['diff', ...baseArgs]);
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
  const mode = decideManifestMode(entries.length, filteredDiffChars, limit);

  const insertions = entries.reduce((s, e) => s + e.added, 0);
  const deletions = entries.reduce((s, e) => s + e.deleted, 0);

  const result = {
    mode,
    range,
    // Time-based seed (minutes since epoch) so reviewer pairs vary across
    // multiple review rounds within the same day, not just day-to-day.
    seed: Math.floor(Date.now() / 60000),
    stats: {
      files: entries.length,
      insertions,
      deletions,
      excluded: excluded.length,
      diffChars: filteredDiffChars,
    },
    excludedSummary: excludedSummary(excluded),
  };

  if (subPath) result.path = subPath;

  if (mode === 'review') {
    result.diff = filteredDiff;
  } else if (mode === 'agent') {
    result.manifestText = renderManifestText(entries, { range, subPath });
  }
  // mode === 'empty': no diff or manifestText

  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
