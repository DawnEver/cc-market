// task-request.test.mjs — an agent may open a task itself, but only under the user's
// authorization (user ruling 2026-11-15): the agent REQUESTS (task.js request), the user's
// own prompt `approve <code>` (the UserPromptSubmit hook) turns that request into a grant,
// and only then does openTask consume it. Nothing the agent writes is a grant.
import { TEST_HOME } from './user-grant.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

void TEST_HOME;
const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');
const AUTHORITY_HOOK = path.join(REM, 'hooks', 'task-authority.js');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-req-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const userTypes = (root, prompt) => spawnSync(process.execPath, [AUTHORITY_HOOK],
  { input: JSON.stringify({ prompt, cwd: root, session_id: 's1', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
const task = (root, ...args) => spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
const codeOf = (r) => r.stdout.match(/approve ([0-9a-f]{6})/)?.[1];

describe('an agent requests, the user approves, the agent opens', () => {
  it('a request alone opens nothing; the user approving its code lets the agent open exactly that slug once', () => {
    const root = repo();
    const asked = task(root, 'request', 'x', 'migrate the store');
    assert.equal(asked.status, 0, asked.stderr);
    const code = codeOf(asked);
    assert.ok(code, 'the request names the code the user approves');
    assert.equal(task(root, 'open', 'x', 'migrate the store').status, 1, 'PLANTED CONTROL: no approval, no open');
    userTypes(root, `approve ${code}`);
    assert.equal(task(root, 'open', 'y', 'other').status, 1, 'the grant is for the requested slug only');
    assert.equal(task(root, 'open', 'x', 'migrate the store').status, 0);
    fs.rmSync(path.join(root, '.claude', 'tasks', 'x'), { recursive: true });
    assert.equal(task(root, 'open', 'x', 'again').status, 1, 'a grant is consumed on use');
  });

  it('the approval must be the whole prompt, in either language, and name a live request', () => {
    const root = repo();
    const code = codeOf(task(root, 'request', 'x', 'goal'));
    userTypes(root, `please do not approve ${code} yet`);
    assert.equal(task(root, 'open', 'x', 'goal').status, 1, 'a prompt that mentions the code is not an approval');
    userTypes(root, 'approve 000000');
    assert.equal(task(root, 'open', 'x', 'goal').status, 1, 'an unknown code grants nothing');
    userTypes(root, `批准 ${code}`);
    assert.equal(task(root, 'open', 'x', 'goal').status, 0);
  });

  it('a refused open names the request door', () => {
    const r = task(repo(), 'open', 'x', 'goal');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task\.js request x/);
  });
});
