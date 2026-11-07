#!/usr/bin/env node
// task-authority.js — UserPromptSubmit hook: when the user's own prompt IS
// `/rem:task open|close <slug> …`, record that authority (scripts/authority.mjs) so
// openTask/closeTask may proceed once. Any other prompt records nothing. Never blocks.
// REM_AUTHORITY_PROBE=1 also logs the raw prompt to the store's probe.jsonl (live check).
// Every prompt runs this: a prompt that cannot be the command (no "task" in it) returns
// before the authority library (crypto, locking) is even loaded.

import { readStdinJSON, isMain } from '../shared/lib.mjs';

if (isMain(import.meta.url)) {
  try {
    const p = readStdinJSON() || {};
    const prompt = p.prompt || p.user_prompt || '';
    const probing = process.env.REM_AUTHORITY_PROBE === '1';
    if (probing || String(prompt).includes('task')) {
      const { recordUserCommand, probe } = await import('../scripts/authority.mjs');
      if (probing) probe(prompt);
      recordUserCommand(typeof p.cwd === 'string' ? p.cwd : process.cwd(), prompt, p.session_id || '');
    }
  } catch { /* a hook never breaks the session */ }
}
