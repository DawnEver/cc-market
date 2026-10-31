// user-grant.mjs — test helper: stand in for the USER typing `/rem:task open|close …`,
// by running the real UserPromptSubmit authority hook with that prompt.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/task-authority.js', import.meta.url));

export function grantIfUserVerb(root, args) {
  if (args[0] !== 'open' && args[0] !== 'close') return;
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: `/rem:task ${args[0]} ${args[1]}`, cwd: root, session_id: 'test' }), encoding: 'utf8',
  });
}
