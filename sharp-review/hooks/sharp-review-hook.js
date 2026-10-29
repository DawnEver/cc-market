#!/usr/bin/env node
// sharp-review-hook.js — Claude Code and Codex Stop hook.
// Deterministic, wave-gated one-pass review trigger. Tracks change accumulation per ref:
//   wave 0 (new territory): low threshold, catch issues early
//   wave 1+ (same ref already reviewed): high threshold, accumulate before re-trigger
//   Resets to wave 0 when HEAD moves to a new commit.
//
// Per-project configurable thresholds in tracked .claude/sharp-review.json.
// Defaults: wave0 = 1000 lines / 15 files, wave1 = 3000 lines / 45 files.
//
// State stored in unified .claude/.rem-state.json under reviewGate key.

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from "../shared/spawn.mjs";
import { findProjectRoot, readStdinJSON as _readStdinJSON, readTranscriptTail as _readTranscriptTail, isMain } from '../shared/lib.mjs';
import { loadState as _loadState, withStateLock } from '../shared/state.mjs';
import { normalizeHookFacts, isCodexHost, hookSessionKey, hasRemReservation } from '../shared/hook-facts.mjs';
import { claimReview } from '../scripts/gate.mjs';
import { evaluateSources, sourceFiles, DOCS_THRESHOLD_DEFAULT, CODEBASE_INTERVAL_MIN_DEFAULT } from '../scripts/sources.mjs';
import { loadReviewConfig } from '../scripts/lib/config.mjs';

// Project-root lookup is shared with installed plugin scripts.
export function findGitRoot(startDir) { return findProjectRoot(startDir); }

export function resolveReviewWorkerTarget(env = process.env) {
  if (isCodexHost(env)) {
    return {
      agentType: 'worker',
      host: 'codex',
      setup: 'Tell it to use the sharp-review skill',
      reason: 'codex-built-in-worker',
    };
  }

  return {
    agentType: 'sharp-review:sharp-review',
    host: 'claude',
    setup: 'The worker executes directly',
    reason: 'claude-dedicated-agent',
  };
}

// The plugin root is this file's grandparent; it must hold the planner the worker runs, or nothing
// the worker runs can work — refuse here rather than dispatch a worker that fails later.
export function resolvePluginRoot(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  if (!existsSync(path.join(root, 'scripts', 'plan.js'))) {
    throw new Error(`sharp-review plugin root ${root} holds no scripts/plan.js`);
  }
  return root;
}

// ── Content-hash gate ──
// A source fires again only when its content changed since its last successful review:
// sessions sharing one checkout alternate on the same state, so a session-scoped gate alone
// re-fired the deps profile every turn on an unchanged dirty tree (2026-10-20).
export function contentHash(entries) {
  const lines = entries.map(([p, digest]) => `${p}\0${digest}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function freshSources(fired, hashes, reviewed) {
  return fired.filter((key) => hashes[key] !== reviewed[key]);
}

function fileDigest(rel) {
  try {
    return createHash('sha256').update(readFileSync(path.join(projectDir, rel))).digest('hex');
  } catch {
    return 'absent';
  }
}

function sourceHashes(fired, changedFiles, head) {
  const hashes = {};
  for (const key of fired) {
    const files = sourceFiles(key, changedFiles);
    hashes[key] = key === 'codebase'
      ? contentHash([['HEAD', head || 'none']])
      : contentHash(files.map((f) => [f, fileDigest(f)]));
  }
  return hashes;
}

export function buildDispatchInstruction(sources, target = resolveReviewWorkerTarget(), pluginRoot = resolvePluginRoot(), gateToken = null) {
  const firedSources = sources || 'diff';
  return (
    `Dispatch ONE ${target.agentType} subagent with firedSources: ${firedSources} and plugin root: ${pluginRoot}. ` +
    (gateToken ? `Pass gateToken: ${gateToken} through plan.js --gate-token; release it with post-review.js --release-gate if no review can run. ` : '') +
    `${target.setup}, execute SKILL.md Steps 0-4 directly, ` +
    `and do not re-dispatch. Relay only its \`Sharp review: <summary>\` line; do not ` +
    `run the steps inline yourself.\n`
  );
}

let projectDir = findProjectRoot();
let unifiedStateFile = path.join(projectDir, '.claude', '.rem-state.json');

const DEFAULT_THRESHOLDS = {
  wave0: { lines: 1000, files: 15 },
  wave1: { lines: 3000, files: 45 },
};

function readStdinJSON() { return _readStdinJSON(); }

function loadUnifiedState() { return _loadState(unifiedStateFile); }


function getChangedFiles() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const entries = out.split('\0'), files = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      files.push(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2))) i++; // -z emits destination first, then the old path.
    }
    return files;
  } catch { return []; }
}

// ── Wave Gate ──

function getCurrentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

function gitRefExists(ref) {
  try {
    execFileSync('git', ['cat-file', '-t', ref], { cwd: projectDir, timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function getDiffStat(sinceRef) {
  try {
    const out = execFileSync('git', ['diff', '--shortstat', sinceRef], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
    if (!m) return { lines: 0, files: 0 };
    const files = parseInt(m[1], 10) || 0;
    const insertions = parseInt(m[2], 10) || 0;
    const deletions = parseInt(m[3], 10) || 0;
    return { lines: insertions + deletions, files };
  } catch { return { lines: 0, files: 0 }; }
}

// Thresholds come from the tracked, shareable `.claude/sharp-review.json` (config), NOT from
// the gitignored runtime `reviewGate` — so a repo's trigger tuning travels with it.
export function loadThresholds(config) {
  const custom = config?.thresholds || {};
  return {
    wave0: { ...DEFAULT_THRESHOLDS.wave0, ...custom.wave0 },
    wave1: { ...DEFAULT_THRESHOLDS.wave1, ...custom.wave1 },
  };
}

function readTranscriptTail(transcriptPath, maxLines = 40) { return _readTranscriptTail(transcriptPath, maxLines); }

export function reviewBlocked(input, facts, state, now = Date.now(), env = {}) {
  const key = hookSessionKey(input, env);
  if (!key && isCodexHost(env)) return true;
  const hook = state.hook || {};
  return Boolean(input.stop_hook_active || facts.waitingForInput ||
    hasRemReservation(hook, now) || hook.taskActiveUntil > now);
}

async function main() {
  const input = readStdinJSON();
  projectDir = findProjectRoot(input.cwd || process.cwd());
  unifiedStateFile = path.join(projectDir, '.claude', '.rem-state.json');
  const transcript = input.transcript_path ? readTranscriptTail(input.transcript_path) : [];
  const facts = normalizeHookFacts(transcript, input);
  const now = Date.now();
  const initial = loadUnifiedState();
  if (reviewBlocked(input, facts, initial, now, process.env)) return;

  const changedFiles = getChangedFiles();
  if (!changedFiles.length && !facts.hasEdits) return;
  const previous = initial.reviewGate || {};
  const reviewCfg = loadReviewConfig(projectDir);
  const head = getCurrentHead();
  const thresholds = loadThresholds(reviewCfg);
  const sameRef = Boolean(previous.lastReviewRef && head === previous.lastReviewRef);
  const wave = sameRef ? (previous.wave || 0) + 1 : 0;
  const threshold = wave === 0 ? thresholds.wave0 : thresholds.wave1;
  let diffRef = previous.lastReviewRef;
  if (!diffRef || !gitRefExists(diffRef)) diffRef = 'HEAD'; // the review reads the tree against HEAD; trigger on that same range
  const stat = getDiffStat(diffRef);
  const effectiveStat = sameRef && previous.lastReviewDiff ? {
    lines: Math.max(0, stat.lines - previous.lastReviewDiff.lines),
    files: Math.max(0, stat.files - previous.lastReviewDiff.files),
  } : stat;
  const lastReviewAt = previous.lastReviewAt || 0;
  const { fired, reasons } = evaluateSources({
    changedFiles, diffStat: effectiveStat, waveThreshold: threshold,
    minutesSinceLastReview: lastReviewAt ? Math.max(0, (now - lastReviewAt) / 60000) : 0,
    docsThreshold: reviewCfg.docsThreshold ?? DOCS_THRESHOLD_DEFAULT,
    codebaseIntervalMin: reviewCfg.codebaseIntervalMin ?? CODEBASE_INTERVAL_MIN_DEFAULT,
  });
  const hashes = sourceHashes(fired, changedFiles, head);
  let pending = null;
  const saved = withStateLock(unifiedStateFile, state => {
    // Recheck under the same lock REM uses: only one continuation can claim the checkout.
    if (reviewBlocked(input, facts, state, now, process.env)) return;
    const result = claimReview(state.reviewGate, {
      sessionId: hookSessionKey(input, process.env) || '', turnId: input.turn_id, head, stat, wave,
      sources: fired, hashes, reasons,
    }, { token: randomUUID(), now });
    state.reviewGate = result.gate;
    if (result.dispatch) pending = result.gate.pending;
  }, { atomic: true, onTimeout: 'throw' });
  if (!saved?.persisted || !pending) return;

  const instruction = buildDispatchInstruction(pending.sources.join(','),
    resolveReviewWorkerTarget(), resolvePluginRoot(), pending.token);
  process.stderr.write(instruction);
  process.exitCode = 2; // Native Stop continuation; no subprocess classifier or implicit model call.
}
// Only run when executed directly (not when imported for testing)
if (isMain(import.meta)) {
  main().catch((e) => {
    process.stderr.write(`[sharp-review] ${e.message}\n`);
    process.exit(0);
  });
}
