#!/usr/bin/env node
// session-context.js — SessionStart + PostCompact hook: one process puts back what a
// fresh or compacted context lacks.
//   - Codex SessionStart (not resume/fork, whose context persists): the host project's
//     .claude/rules (scripts/rules-context.js) — Claude Code auto-loads them itself.
//   - Both hosts: the saved memos with FRESH/STALE (scripts/memo.js memoLines) — after a
//     compaction dropped the excerpts those facts were paid for. Nothing saved: no output.
// Codex restores on SessionStart source=compact; its PostCompact takes no context.
// Never exits non-zero: a hook miss must not break the session.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { isCodexHost } from '../shared/hook-facts.mjs';

/** Resume/fork inherit context; startup, clear and compact must restore it. */
export function isResume(payload) { return ['resume', 'fork'].includes(payload?.source); }

/** The hook's stdout for this payload ('' for none). `codex` is the host. */
export async function sessionContext(payload, codex = isCodexHost()) {
  const event = payload.hook_event_name || payload.hookEventName || 'SessionStart';
  if (codex && event === 'PostCompact') return '';
  const parts = [];
  if (codex && !isResume(payload)) {
    const { rulesContext } = await import('../scripts/rules-context.js');
    const rules = rulesContext(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    if (rules) parts.push(rules);
  }
  try {
    const { memoLines } = await import('../scripts/memo.js');
    const lines = memoLines();
    if (lines.length) parts.push(lines.join('\n'));
  } catch { /* a broken memo store costs its listing, never the session */ }
  if (!parts.length) return '';
  const text = parts.join('\n\n');
  return codex
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
    : `${text}\n`;
}

if (isMain(import.meta.url)) {
  try {
    let payload = {};
    try { payload = readStdinJSON() || {}; } catch { /* no payload */ }
    process.stdout.write(await sessionContext(payload));
  } catch { /* never break the session */ }
}
