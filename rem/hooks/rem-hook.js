#!/usr/bin/env node
// rem-hook.js — Claude Code Stop hook
// Triggers /rem after 3+ stops AND either (2+ min session) OR (substantive code edits).
// State tracked in unified .claude/.rem-state.json

import { readFileSync } from 'fs';
import { loadState, saveState } from '../lib.mjs';

const MIN_STOP_COUNT = 3;
const MIN_SESSION_MS = 2 * 60 * 1000;
const MIN_SESSION_MS_SUBSTANTIVE = 30 * 1000; // 30s if real code changes happened
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

// ── Pure helpers ──

export function readTranscriptTail(transcriptPath, maxLines = 40) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function hasSubstantiveWork(transcript) {
  return transcript.some(entry => {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block =>
      block?.type === 'tool_use' &&
      ['Edit', 'Write', 'NotebookEdit'].includes(block?.name)
    );
  });
}

export function isFreshSession(state, inputKey, now) {
  if (!state) return true;
  const storedKey = state.hook.sessionKey ?? null;
  if (inputKey != null && storedKey != null && storedKey !== inputKey) return true;
  if (now - (state.hook.lastTouched || 0) > SESSION_EXPIRY_MS) return true;
  return false;
}

export function decideStop(state, input, now) {
  const inputKey = input.session_id ?? null;
  const fresh = isFreshSession(state, inputKey, now);

  if (fresh) {
    state.hook = {
      sessionKey: inputKey ?? null,
      stopCount: 0,
      firstStopAt: null,
      remPending: false,
      remDone: false,
      lastTouched: now,
      taskActiveUntil: null,
    };
  }

  const backgroundTasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const taskActiveUntil = Number.isFinite(state.hook.taskActiveUntil) ? state.hook.taskActiveUntil : 0;
  const hasPendingWork = backgroundTasks.length > 0 || now < taskActiveUntil;

  if (!hasPendingWork) {
    state.hook.stopCount = (state.hook.stopCount || 0) + 1;
    if (!state.hook.firstStopAt) state.hook.firstStopAt = now;
  }
  state.hook.lastTouched = now;

  const sessionAge = now - (state.hook.firstStopAt || now);
  const stopCount = state.hook.stopCount;

  let decision = 'allow';

  if (state.hook.remDone) {
    decision = 'allow';
  } else if (hasPendingWork) {
    decision = 'allow';
  } else if (state.hook.remPending) {
    state.hook.remPending = false;
    state.hook.remDone = true;
    decision = 'allow';
  } else if (stopCount >= MIN_STOP_COUNT) {
    const transcriptPath = input.transcript_path || '';
    const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : [];
    const isSubstantive = hasSubstantiveWork(transcript);
    const minAge = isSubstantive ? MIN_SESSION_MS_SUBSTANTIVE : MIN_SESSION_MS;
    if (sessionAge >= minAge) {
      state.hook.remPending = true;
      decision = 'deny';
    }
  }

  return { state, decision };
}

// ── Main ──

function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

// Only run main logic when executed directly (not imported for testing)
const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirect) {
  const input = readStdinJSON();
  const now = Date.now();
  let state = loadState();
  const { state: newState, decision } = decideStop(state, input, now);
  saveState(newState);

  if (decision === 'deny') {
    process.stderr.write('/rem\n', () => process.exit(2));
  } else {
    process.exit(0);
  }
}
