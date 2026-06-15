#!/usr/bin/env node
// review-gate-hook.js — Claude Code Stop hook
// Wave-gated adaptive review trigger. Tracks change accumulation per ref:
//   wave 0 (new territory): low threshold, catch issues early
//   wave 1+ (same ref already reviewed): high threshold, accumulate before re-trigger
//   Resets to wave 0 when HEAD moves to a new commit.
//
// Per-project configurable thresholds in .claude/.rem-state.json → reviewGate.thresholds.
// Defaults: wave0 = 300 lines / 5 files, wave1 = 1000 lines / 15 files.
//
// State stored in unified .claude/.rem-state.json under reviewGate key.

import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { findProjectRoot, readStdinJSON as _readStdinJSON, readTranscriptTail as _readTranscriptTail, isMain } from '../shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState } from '../shared/state.mjs';

// Backward compat: keep findGitRoot export for sharp-review/tests/hook.test.mjs
export function findGitRoot(startDir) { return findProjectRoot(startDir); }

const projectDir = findProjectRoot();
const unifiedStateFile = path.join(projectDir, '.claude', '.rem-state.json');
const MEMORY_MAX = 20;
const TARGETS = { none: 0, once: 1, multi: 2 };

const DEFAULT_THRESHOLDS = {
  wave0: { lines: 300, files: 5 },
  wave1: { lines: 1000, files: 15 },
};

function readStdinJSON() { return _readStdinJSON(); }

function loadUnifiedState() { return _loadState(unifiedStateFile); }

function saveUnifiedState(state) { return _saveState(unifiedStateFile, state); }

function loadReviewGate() {
  const unified = loadUnifiedState();
  return unified.reviewGate || null;
}

function saveReviewGate(reviewGate) {
  const unified = loadUnifiedState();
  unified.reviewGate = reviewGate;
  saveUnifiedState(unified);
}

function loadClassifierMemory() {
  const unified = loadUnifiedState();
  return unified.reviewGate?.memory || [];
}

function appendClassifierMemory(entry) {
  const unified = loadUnifiedState();
  if (!unified.reviewGate) unified.reviewGate = {};
  let memory = unified.reviewGate.memory || [];
  memory.push(entry);
  if (memory.length > MEMORY_MAX) memory = memory.slice(-MEMORY_MAX);
  unified.reviewGate.memory = memory;
  saveUnifiedState(unified);
}

function getChangedFiles() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}

const DOC_ONLY_PATTERNS = [/\.md$/i, /^memories\//, /^\.claude\//, /^MEMORY\.md$/i, /^README/i];

function isDocOnly(files) {
  return files.length > 0 && files.every(f => DOC_ONLY_PATTERNS.some(p => p.test(f)));
}

// ── Wave Gate ──

function getCurrentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, timeout: 5000 }).toString().trim();
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

function loadThresholds(reviewGate) {
  const custom = reviewGate?.thresholds || {};
  return {
    wave0: { ...DEFAULT_THRESHOLDS.wave0, ...custom.wave0 },
    wave1: { ...DEFAULT_THRESHOLDS.wave1, ...custom.wave1 },
  };
}

function readTranscriptTail(transcriptPath, maxLines = 40) { return _readTranscriptTail(transcriptPath, maxLines); }

function hasCodeEdits(transcript) {
  return transcript.some(entry => {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block =>
      block?.type === 'tool_use' &&
      ['Edit', 'Write', 'NotebookEdit'].includes(block?.name)
    );
  });
}

function isAwaitingInput(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry?.message?.role !== 'assistant') break;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]?.type === 'text') {
        return /[?？]$/.test(content[j].text.trim());
      }
    }
  }
  return false;
}

function extractTaskSummary(transcript) {
  const msgs = transcript
    .filter(e => e?.message?.role === 'assistant')
    .flatMap(e => {
      const c = e?.message?.content;
      return Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text) : [];
    })
    .join(' ')
    .slice(0, 800);
  return msgs || '(no summary)';
}

function classify(taskSummary, changedFiles, memory) {
  const examples = memory.slice(-5).map(m =>
    `Task: ${m.task.slice(0, 120)}\nFiles: ${(m.files || []).join(', ')}\nMode: ${m.mode}`
  ).join('\n---\n');

  const prompt = `You are a code review gate classifier. Decide how many rounds of critique to run.

Modes:
- none: trivial task, no code logic changed, or purely informational
- once: moderate code change, single review pass is enough
- multi: complex multi-file change, algorithm change, or high-risk logic

${examples ? `Past examples:\n${examples}\n---\n` : ''}Current task summary:
${taskSummary}

Changed files: ${changedFiles.join(', ') || 'none'}

Respond ONLY with valid JSON: {"mode": "none"|"once"|"multi", "reason": "one sentence"}`;

  try {
    const result = spawnSync('claude', ['-p', prompt, '--max-tokens', '80'], {
      env: { ...process.env, SHARP_REVIEW_CLASSIFY: '1' },
      timeout: 15000,
      encoding: 'utf8',
    });
    const text = result.stdout || '';
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const mode = ['none', 'once', 'multi'].includes(parsed.mode) ? parsed.mode : 'once';
    return { mode, reason: parsed.reason || '' };
  } catch {
    return { mode: 'once', reason: 'classifier error' };
  }
}

async function main() {
  if (process.env.SHARP_REVIEW_CLASSIFY) process.exit(0);

  const input = readStdinJSON();

  if (input.stop_hook_active) process.exit(0);

  const sessionId = input.session_id || '';
  const transcriptPath = input.transcript_path || '';

  const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : [];

  // Conversation still active — assistant is waiting for user input
  if (isAwaitingInput(transcript)) process.exit(0);

  const changedFiles = getChangedFiles();

  if (isDocOnly(changedFiles) || (changedFiles.length === 0 && !hasCodeEdits(transcript))) {
    process.exit(0);
  }

  const now = Date.now();
  let reviewGate = loadReviewGate();
  const isFresh = !reviewGate || reviewGate.sessionId !== sessionId;

  if (isFresh) {
    // ── Wave gate ──
    const head = getCurrentHead();
    const thresholds = loadThresholds(reviewGate);
    const lastRef = reviewGate?.lastReviewRef;

    // Wave resets to 0 when HEAD moves to a new commit, otherwise increments
    const sameRef = !!(lastRef && head && head === lastRef);
    const wave = sameRef ? ((reviewGate.wave ?? 0) + 1) : 0;
    const threshold = wave === 0 ? thresholds.wave0 : thresholds.wave1;

    // Resolve diff reference: use lastReviewRef, fall back to HEAD~1 or HEAD
    let diffRef = lastRef;
    if (!diffRef || !gitRefExists(diffRef)) {
      diffRef = gitRefExists('HEAD~1') ? 'HEAD~1' : 'HEAD';
    }

    const stat = getDiffStat(diffRef);

    // For same-ref, only count new changes since the last review.
    // This prevents "one more file" from re-triggering after wave1 is reached.
    let effectiveStat = stat;
    if (sameRef && reviewGate.lastReviewDiff) {
      effectiveStat = {
        lines: Math.max(0, stat.lines - reviewGate.lastReviewDiff.lines),
        files: Math.max(0, stat.files - reviewGate.lastReviewDiff.files),
      };
    }

    if (effectiveStat.lines < threshold.lines && effectiveStat.files < threshold.files) {
      // Accumulated changes below wave threshold — skip, preserve ref for accumulation
      reviewGate = {
        ...(reviewGate || {}),
        sessionId,
        mode: 'none',
        reason: `wave-${wave} gate: ${effectiveStat.lines}L/${effectiveStat.files}F < ${threshold.lines}L/${threshold.files}F`,
        reviewCount: 0,
        classifiedAt: now,
      };
      saveReviewGate(reviewGate);
      process.exit(0);
    }

    // ── Gate passed — classify review depth ──
    const taskSummary = extractTaskSummary(transcript);
    const memory = loadClassifierMemory();
    let classification;
    try {
      classification = classify(taskSummary, changedFiles, memory);
    } catch {
      classification = { mode: 'once', reason: 'classifier error' };
    }

    reviewGate = {
      sessionId,
      mode: classification.mode,
      reason: classification.reason,
      reviewCount: 0,
      classifiedAt: now,
      lastReviewRef: head,
      lastReviewDiff: stat,
      wave,
      memory,
      thresholds: reviewGate?.thresholds,
    };
    saveReviewGate(reviewGate);

    appendClassifierMemory({ task: taskSummary.slice(0, 200), files: changedFiles.slice(0, 10), mode: classification.mode });
  }

  const target = TARGETS[reviewGate.mode] ?? 1;

  if (reviewGate.reviewCount >= target) {
    process.exit(0);
  }

  reviewGate.reviewCount += 1;
  saveReviewGate(reviewGate);

  process.stderr.write('/sharp-review\n', () => process.exit(2));
}

// Only run when executed directly (not when imported for testing)
if (isMain(import.meta)) main().catch(() => process.exit(0));
