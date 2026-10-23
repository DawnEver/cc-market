#!/usr/bin/env node
// Explicit successful-work acknowledgement for a pending REM continuation.
import { stateFile } from './lib.mjs';
import { withStateLock } from '../shared/state.mjs';
import { isMain } from '../shared/lib.mjs';
import { completeSession } from '../hooks/rem-hook.js';

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  try {
    if (args[0] !== 'complete' || !args.includes('--session') || !args.includes('--request'))
      throw new Error('Usage: rem-session.js complete --session <id> --request <request-id>');
    withStateLock(stateFile, state => completeSession(state, value('--session'), value('--request')), { atomic: true, onTimeout: 'throw' });
    console.log('REM request completed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
