#!/usr/bin/env node
// task-authority.js — UserPromptSubmit hook: when the user's own prompt IS
// `/rem:task open|close <slug> …`, record that authority (scripts/authority.mjs) so
// openTask/closeTask may proceed once. Any other prompt records nothing. Never blocks.
// REM_AUTHORITY_PROBE=1 also logs the raw prompt to the store's probe.jsonl (live check).

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { recordUserCommand, probe } from '../scripts/authority.mjs';

if (isMain(import.meta.url)) {
  try {
    const p = readStdinJSON() || {};
    if (process.env.REM_AUTHORITY_PROBE === '1') probe(p.prompt || p.user_prompt || '');
    recordUserCommand(typeof p.cwd === 'string' ? p.cwd : process.cwd(), p.prompt || p.user_prompt || '', p.session_id || '');
  } catch { /* a hook never breaks the session */ }
}
