#!/usr/bin/env node
// user-prompt.js — rem's ONE UserPromptSubmit hook, both hosts. Every prompt waits for every hook of
// its event, and the whole event finishes under 5 s across every source (user ruling D24), so rem
// pays ONE node start per prompt, not one per behaviour:
//   1. the task authority (hooks/task-authority.js): record /rem:task and approvals, bind `task: <slug>`;
//   2. then recall (scripts/recall.js scopedContext), which therefore already sees a binding made by
//      this very prompt: it reads a ready index and hands any rebuild to a detached background job.
// Each half is isolated: one failing never stops the other, and nothing ever breaks the session.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { authorityContext } from './task-authority.js';
import { scopedContext } from '../scripts/recall.js';

export async function promptContext(p) {
  const parts = [];
  try { const said = await authorityContext(p); if (said) parts.push(said); } catch { /* isolated */ }
  try {
    const prompt = p.prompt || p.user_prompt || '';
    const cwd = typeof p.cwd === 'string' ? p.cwd : process.cwd();
    const session = typeof p.session_id === 'string' && p.session_id ? p.session_id : null;
    const recalled = scopedContext(prompt, cwd, Date.now(), { session });
    if (recalled) parts.push(recalled);
  } catch { /* a recall miss never breaks the session */ }
  return parts.length ? parts.join('\n\n') : null;
}

if (isMain(import.meta.url)) {
  let p = {};
  try { p = readStdinJSON() || {}; } catch { /* no payload */ }
  const context = await promptContext(p);
  if (context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  }
  process.exitCode = 0;
}
