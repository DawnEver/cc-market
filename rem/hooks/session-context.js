#!/usr/bin/env node
// session-context.js — SessionStart + PostCompact hook: one process puts back what a
// fresh or compacted context lacks.
//   - Codex / Antigravity SessionStart (not resume/fork, whose context persists): the host project's
//     .claude/rules (scripts/rules-context.js) — Claude Code auto-loads them itself.
//   - All hosts: recall's session record is dropped, so the next prompt re-injects the task line.
//   - All hosts: the saved memos with FRESH/STALE (scripts/memo.js memoLines) — after a
//     compaction dropped the excerpts those facts were paid for. Nothing saved: no output.
// Codex restores on SessionStart source=compact; its PostCompact takes no context.
// Never exits non-zero: a hook miss must not break the session.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { isCodexHost, isAgyHost, normalizeHookInput, hookOutput } from '../shared/hook-facts.mjs';

/** Resume/fork inherit context; startup, clear and compact must restore it. */
export function isResume(payload) { return ['resume', 'fork'].includes(payload?.source); }

/** The hook's stdout for this payload ('' for none). `codex` / `agy` select the host. */
export async function sessionContext(payload, codex = isCodexHost(), agy = false) {
  const event = payload.hook_event_name || payload.hookEventName || 'SessionStart';
  if (payload.session_id && !isResume(payload)) {
    // recall.js injects the bound task's line only when it changed; a fresh or compacted context
    // lacks it, so the session's record is dropped and the next prompt carries the line again.
    try { (await import('../scripts/session-record.mjs')).forgetSession(payload.session_id); } catch { /* none */ }
  }
  if (codex && event === 'PostCompact') return '';
  const parts = [];
  if ((codex || agy) && !isResume(payload)) {
    const { rulesContext } = await import('../scripts/rules-context.js');
    const rules = rulesContext(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    if (rules) parts.push(rules);
  }
  try {
    const { memoLines } = await import('../scripts/memo.js');
    const lines = memoLines();
    if (lines.length) parts.push(lines.join('\n'));
  } catch { /* a broken memo store costs its listing, never the session */ }
  if (agy) return hookOutput({ host: 'agy', event: 'SessionStart', kind: 'context', reason: parts.join('\n\n') }).stdout;
  if (!parts.length) return '';
  const text = parts.join('\n\n');
  return codex
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
    : `${text}\n`;
}

if (isMain(import.meta.url)) {
  const explicitAgy = process.argv.includes('--host=agy') ||
    (process.argv.indexOf('--host') >= 0 && process.argv[process.argv.indexOf('--host') + 1] === 'agy');
  let agy = explicitAgy;
  try {
    let payload = {};
    try { payload = readStdinJSON() || {}; } catch { /* no payload */ }
    agy = explicitAgy || Boolean(payload && Object.keys(payload).length && isAgyHost(payload));
    process.stdout.write(await sessionContext(normalizeHookInput(payload), agy ? false : isCodexHost(), agy));
  } catch {
    if (agy) process.stdout.write('{}');
  }
}
