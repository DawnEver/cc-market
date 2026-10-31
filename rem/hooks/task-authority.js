#!/usr/bin/env node
// task-authority.js — UserPromptSubmit hook: when the user's own prompt IS
// `/rem:task open|close <slug> …`, record that authority (scripts/authority.mjs) so
// openTask/closeTask may proceed once. Any other prompt records nothing. Never blocks.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { recordUserCommand } from '../scripts/authority.mjs';

if (isMain(import.meta.url)) {
  try {
    const p = readStdinJSON() || {};
    recordUserCommand(typeof p.cwd === 'string' ? p.cwd : process.cwd(), p.prompt || p.user_prompt || '', p.session_id || '');
  } catch { /* a hook never breaks the session */ }
}
