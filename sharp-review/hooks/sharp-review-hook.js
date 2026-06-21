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
import { evaluateSources, DOCS_THRESHOLD_DEFAULT, CODEBASE_INTERVAL_MIN_DEFAULT } from '../scripts/sources.mjs';
import { loadReviewConfig } from '../scripts/lib/config.mjs';

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

function getChangedFiles() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
    return out.split('\n').map(l => {
      const p = l.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      return arrow === -1 ? p : p.slice(arrow + 4);
    }).filter(Boolean);
  } catch { return []; }
}

// ── Wave Gate ──

function getCurrentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
  } catch { return null; }
}

function gitRefExists(ref) {
  try {
    execFileSync('git', ['cat-file', '-t', ref], { cwd: projectDir, timeout: 5000, stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

function getDiffStat(sinceRef) {
  try {
    const out = execFileSync('git', ['diff', '--shortstat', sinceRef], { cwd: projectDir, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
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
function loadThresholds(config) {
  const custom = config?.thresholds || {};
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
    const result = spawnSync('claude', ['-p', prompt], {
      env: { ...process.env, SHARP_REVIEW_CLASSIFY: '1' },
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
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

  // A doc-only change no longer auto-skips: the `docs` source may fire (governed below by
  // source evaluation). Only skip outright when there is nothing at all to review.
  if (changedFiles.length === 0 && !hasCodeEdits(transcript)) {
    process.exit(0);
  }

  const now = Date.now();
  let reviewGate = loadReviewGate();
  const reviewCfg = loadReviewConfig(projectDir);   // tracked config (thresholds, source tuning)
  const isFresh = !reviewGate || reviewGate.sessionId !== sessionId;

  if (isFresh) {
    // ── Wave gate ──
    const head = getCurrentHead();
    const thresholds = loadThresholds(reviewCfg);
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

    // ── Source evaluation ──
    // The diff source reproduces the wave gate exactly (effectiveStat vs the wave threshold);
    // the other sources (codebase/deps/docs) widen the trigger. The hook owns all I/O and
    // builds the pure ctx; evaluateSources decides what fired.
    // No prior timestamp on a never-reviewed repo → treat as 0 (don't fire a codebase survey
    // on the very first stop); the 7-day clock starts once the first review is recorded.
    const lastReviewAt = reviewGate?.classifiedAt || reviewGate?.lastReviewAt || 0;
    const minutesSinceLastReview = lastReviewAt ? Math.max(0, (now - lastReviewAt) / 60000) : 0;
    const { fired, reasons } = evaluateSources({
      changedFiles,
      diffStat: effectiveStat,
      waveThreshold: threshold,
      minutesSinceLastReview,
      docsThreshold: reviewCfg.docsThreshold ?? DOCS_THRESHOLD_DEFAULT,
      codebaseIntervalMin: reviewCfg.codebaseIntervalMin ?? CODEBASE_INTERVAL_MIN_DEFAULT,
    });

    if (fired.length === 0) {
      // Nothing fired — skip, preserve ref for accumulation
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

    const updatedMemory = [
      ...memory,
      { task: taskSummary.slice(0, 200), files: changedFiles.slice(0, 10), mode: classification.mode },
    ].slice(-MEMORY_MAX);

    reviewGate = {
      sessionId,
      mode: classification.mode,
      reason: classification.reason,
      reviewCount: 0,
      classifiedAt: now,
      lastReviewRef: head,
      lastReviewDiff: stat,
      wave,
      firedSources: fired,        // skill passes these to pick-profile --sources
      firedReasons: reasons,
      memory: updatedMemory,
      // Config (thresholds / source tuning) lives in the tracked .claude/sharp-review.json —
      // never copied into this gitignored runtime state, so the two can't drift.
    };
    saveReviewGate(reviewGate);
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
