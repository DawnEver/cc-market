#!/usr/bin/env node
// rem-hook.js — Claude Code and Codex Stop gate.
// Requests REM after 3+ stops AND sufficient session age; requests are not completion.
// State tracked in unified .claude/.rem-state.json

import { stateFile } from "../scripts/lib.mjs";
import { withStateLock } from '../shared/state.mjs';
import { normalizeHookFacts, isCodexHost, hookSessionKey, hasRemReservation } from '../shared/hook-facts.mjs';
import { fileURLToPath } from 'node:url';
export { isCodexHost } from '../shared/hook-facts.mjs';
import { readStdinJSON, readTranscriptTail as _readTranscriptTail, isMain } from '../shared/lib.mjs';

const MIN_STOP_COUNT = 3;
const MIN_SESSION_MS = 2 * 60 * 1000;
const MIN_SESSION_MS_SUBSTANTIVE = 30 * 1000; // 30s if real code changes happened
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

// ── Pure helpers ──

// Public helper, implemented by the bundled shared transcript reader.
export function readTranscriptTail(transcriptPath, maxLines = 40) { return _readTranscriptTail(transcriptPath, maxLines); }

export function hasSubstantiveWork(transcript) {
  return normalizeHookFacts(transcript).hasEdits;
}

export function isAwaitingInput(transcript) {
  return normalizeHookFacts(transcript).waitingForInput;
}

export function isFreshSession(state, inputKey, now) {
  if (!state) return true;
  const storedKey = state.hook.sessionKey ?? null;
  // A null inputKey is always-different: without a session discriminator there
  // is no way to prove two invocations belong to the same session, so never
  // carry remPending/remDone across them (null/null collision leak).
  if (inputKey == null) return true;
  // A keyed session following an unkeyed (legacy null) stored session is by
  // definition a different session.
  if (storedKey == null) return true;
  if (storedKey !== inputKey) return true;
  if (now - (state.hook.lastTouched || 0) > SESSION_EXPIRY_MS) return true;
  return false;
}

// Fallback discriminator when the hook input carries neither session_id nor
// transcript_path: a per-process id. Persisting it means the NEXT invocation
// (a different process, hence a different fallback) sees storedKey != null &&
// !== inputKey(null) → fresh — so two distinct sessions that both lack
// session_id can never collide on a shared null key and leak remPending.
const FALLBACK_SESSION_KEY = `proc-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

export function decideStop(state, input, now, env = {}) {
  // transcript_path is stable within a session and unique across sessions —
  // a valid discriminator for hosts that omit session_id.
  const inputKey = hookSessionKey(input, env);
  if (!inputKey && isCodexHost(env)) return { state, decision: 'allow' };
  const fresh = isFreshSession(state, inputKey, now);

  if (fresh) {
    state.hook = {
      sessionKey: inputKey ?? FALLBACK_SESSION_KEY,
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

  const transcriptPath = input.transcript_path || '';
  const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : [];
  const awaitingInput = !hasPendingWork && normalizeHookFacts(transcript, input).waitingForInput;

  if (!hasPendingWork && !awaitingInput) {
    state.hook.stopCount = (state.hook.stopCount || 0) + 1;
    if (!state.hook.firstStopAt) state.hook.firstStopAt = now;
  }
  state.hook.lastTouched = now;

  const sessionAge = now - (state.hook.firstStopAt || now);
  const stopCount = state.hook.stopCount;

  let decision = 'allow';

  if (state.hook.remDone) {
    decision = 'allow';
  } else if (hasPendingWork || awaitingInput || input.stop_hook_active) {
    decision = 'allow';
  } else if (state.hook.remPending) {
    // A continuation request is not evidence that the skill finished. Only the
    // explicit completion command can acknowledge the matching request.
    decision = 'allow';
  } else if (stopCount >= MIN_STOP_COUNT) {
    const isSubstantive = hasSubstantiveWork(transcript);
    const minAge = isSubstantive ? MIN_SESSION_MS_SUBSTANTIVE : MIN_SESSION_MS;
    if (sessionAge >= minAge) {
      state.hook.remPending = true;
      decision = 'deny';
    }
  }

  return { state, decision };
}

export function resolveHookExit(decision, env = process.env) {
  if (decision !== 'deny') return { code: 0, stderr: '' };
  if (isCodexHost(env)) return { code: 2, stderr: 'Run the REM skill in this session context before finishing. Do not fork into a worker without inherited context.\n' };
  return { code: 2, stderr: '/rem\n' };
}

export function decideSessionStop(state, input, now, env = {}) {
  const nativeKey = hookSessionKey(input, env);
  if (!nativeKey && isCodexHost(env)) return { state, decision: 'allow' };
  state.hook ??= {};
  state.hook.sessions ??= {};
  const key = nativeKey || FALLBACK_SESSION_KEY;
  for (const [id, record] of Object.entries(state.hook.sessions))
    if (now - (record.lastTouched || 0) > SESSION_EXPIRY_MS) delete state.hook.sessions[id];
  const session = state.hook.sessions[key] ?? { sessionKey: null, lastTouched: 0 };
  if (state.reviewGate?.pending?.expiresAt > now || hasRemReservation(state.hook, now, key))
    return { state, decision: 'allow' };
  const view = { hook: { ...session, taskActiveUntil: Math.max(session.taskActiveUntil || 0, state.hook.taskActiveUntil || 0) } };
  if (view.hook.remPending && !(view.hook.requestExpiresAt > now)) view.hook.remPending = false;
  const result = decideStop(view, input, now, env);
  if (result.decision === 'deny') {
    result.state.hook.requestId = `${key}:${now}`;
    result.state.hook.requestExpiresAt = now + SESSION_EXPIRY_MS;
  }
  state.hook.sessions[key] = result.state.hook;
  return { state, decision: result.decision, sessionKey: key, requestId: result.state.hook.requestId };
}

export function completeSession(state, session, request, now = Date.now()) {
  const record = state.hook?.sessions?.[session];
  if (!request || !record?.remPending || record.requestId !== request || !(record.requestExpiresAt > now))
    throw new Error('REM completion requires a matching pending session request');
  record.remPending = false;
  record.remDone = true;
  record.completedAt = now;
}

export function acknowledgementCommand(script, session, request) {
  const data = Buffer.from(JSON.stringify([script, 'complete', '--session', session, '--request', request])).toString('base64');
  return `node -e "const a=JSON.parse(Buffer.from('${data}','base64').toString());const r=require('node:child_process').spawnSync(process.execPath,a,{stdio:'inherit'});process.exit(r.error?1:(r.status??1))"`;
}

// ── Main ──

// Only run main logic when executed directly (not imported for testing)
if (isMain(import.meta)) {
  const input = readStdinJSON();
  const now = Date.now();
  let result;
  try {
    const saved = withStateLock(stateFile, state => { result = decideSessionStop(state, input, now, process.env); }, { onTimeout: 'throw' });
    if (!saved?.persisted) process.exit(0);
  } catch { process.exit(0); }
  const { code, stderr } = resolveHookExit(result?.decision);
  const acknowledgement = code === 2 && result.requestId ?
    `After the skill succeeds, run ${acknowledgementCommand(fileURLToPath(new URL('../scripts/rem-session.js', import.meta.url)), result.sessionKey, result.requestId)} in the current project directory. Paths and IDs are encoded argv data. Do not acknowledge failed or unfinished work.\n` : '';
  if (stderr) process.stderr.write(stderr + acknowledgement, () => process.exit(code));
  else process.exit(code);
}
