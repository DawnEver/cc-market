// user-grant.mjs — test helper: stand in for the USER typing `/rem:task open|close …`,
// by running the real UserPromptSubmit authority hook with that prompt.
//
// Importing it points HOME/USERPROFILE at a fresh temp directory for this test process
// and every child it spawns, so the real user's authority store (~/.claude/rem/authority/)
// is never touched by a test. The machine home ($LAB_COMMONS_HOME, which holds the session bindings) moves
// there too, so no test ever writes the live machine home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/user-prompt.js', import.meta.url));
export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.LAB_COMMONS_HOME = path.join(TEST_HOME, 'machine-home');
// The forge a task's identity lives on (scripts/task-forge.mjs): a fake one per test process, never the real forge.
process.env.REM_FAKE_FORGE = path.join(TEST_HOME, 'forge');
process.env.REM_FORGE = JSON.stringify([process.execPath, fileURLToPath(new URL('./fixtures/fake-forge.mjs', import.meta.url))]);

export function grantIfUserVerb(root, args) {
  if (args[0] !== 'open' && args[0] !== 'close') return;
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: `/rem:task ${args[0]} ${args[1]}`, cwd: root, session_id: 'test' }), encoding: 'utf8',
  });
}
