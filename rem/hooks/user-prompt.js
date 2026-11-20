#!/usr/bin/env node
// user-prompt.js — rem's ONE UserPromptSubmit hook (PreInvocation on Antigravity), across all hosts. Every prompt
// waits for every hook of its event, and the whole event finishes under 5 s across every source (user ruling D24),
// so rem pays ONE node start per prompt, not one per behaviour:
//   1. the task authority (hooks/task-authority.js): record /rem:task and approvals, bind `task: <slug>`;
//   2. then recall (scripts/recall.js scopedContext), which therefore already sees a binding made by
//      this very prompt: it reads a ready index and hands any rebuild to a detached background job.
// Each half is isolated: one failing never stops the other, and nothing ever breaks the session.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { isAgyHost, normalizeHookInput, isFirstInvocation, hookSessionKey, hookOutput } from '../shared/hook-facts.mjs';
import { authorityContext } from './task-authority.js';
import { scopedContext } from '../scripts/recall.js';

export async function promptContext(p) {
  const parts = [];
  try { const said = await authorityContext(p); if (said) parts.push(said); } catch { /* isolated */ }
  try {
    const prompt = p.prompt || p.user_prompt || '';
    const cwd = typeof p.cwd === 'string' ? p.cwd : process.cwd();
    const session = hookSessionKey(p) || (typeof p.session_id === 'string' && p.session_id ? p.session_id : null);
    const recalled = scopedContext(prompt, cwd, Date.now(), { session });
    if (recalled) parts.push(recalled);
  } catch { /* a recall miss never breaks the session */ }
  return parts.length ? parts.join('\n\n') : null;
}

if (isMain(import.meta.url)) {
  const explicitAgy = process.argv.includes('--host=agy') ||
    (process.argv.indexOf('--host') >= 0 && process.argv[process.argv.indexOf('--host') + 1] === 'agy');
  let raw = {};
  try { raw = readStdinJSON() || {}; } catch { raw = {}; }
  const agy = explicitAgy || Boolean(raw && Object.keys(raw).length && isAgyHost(raw));
  // agy: PreInvocation precedes every model call; run authority + recall once per turn, on the first.
  if (agy && !isFirstInvocation(raw)) {
    process.stdout.write('{}');
  } else {
    const p = agy ? normalizeHookInput(raw) : raw;
    const context = await promptContext(p);
    if (agy) {
      process.stdout.write(hookOutput({ host: 'agy', event: 'PreInvocation', kind: 'context', reason: context || '' }).stdout);
    } else if (context) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
    }
  }
  process.exitCode = 0;
}
