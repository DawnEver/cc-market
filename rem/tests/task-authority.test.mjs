// task-authority.test.mjs — only the USER opens or closes a task, enforced at the cause:
// openTask/closeTask consume a record that only the user's own prompt can create (the
// UserPromptSubmit hook). The PreToolUse guard is a second line; scope-validate detects a
// TASK.md written around the library. Every bypass the review found is planted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openTask, closeTask } from '../scripts/tasks.mjs';
import { decideTaskGuard } from '../hooks/task-guard.js';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');
const AUTHORITY_HOOK = path.join(REM, 'hooks', 'task-authority.js');
const VALIDATE = path.join(REM, 'scripts', 'scope-validate.mjs');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-auth-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const userTypes = (root, prompt) => spawnSync(process.execPath, [AUTHORITY_HOOK],
  { input: JSON.stringify({ prompt, cwd: root, session_id: 's1', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
const task = (root, ...args) => spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

describe('the library refuses without the user\'s own command', () => {
  it('openTask from an agent (node -e import, or task.js directly) is refused', () => {
    const root = repo();
    assert.throws(() => openTask(root, 'x', 'goal'), /no user authority/);
    const r = task(root, 'open', 'x', 'goal');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no user authority/);
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'tasks', 'x')));
  });

  it('the user typing /rem:task open authorises exactly that verb and slug, exactly once', () => {
    const root = repo();
    userTypes(root, '/rem:task open x "migrate the store"');
    assert.equal(task(root, 'open', 'y', 'other slug').status, 1);
    assert.equal(task(root, 'open', 'x', 'migrate the store').status, 0);
    const text = fs.readFileSync(path.join(root, '.claude', 'tasks', 'x', 'TASK.md'), 'utf8');
    const id = text.match(/^authority: ([0-9a-f]{12})$/m)?.[1];
    assert.ok(id, 'TASK.md records the user authority id');
    assert.match(fs.readFileSync(path.join(root, '.claude', 'tasks', 'x', 'JOURNAL.md'), 'utf8'), new RegExp(`opened: .*\\(authority ${id}\\)$`, 'm'));
    fs.rmSync(path.join(root, '.claude', 'tasks', 'x'), { recursive: true });
    assert.equal(task(root, 'open', 'x', 'again').status, 1, 'a record is consumed on use');
  });

  it('closeTask needs its own user record', () => {
    const root = repo();
    userTypes(root, '/rem:task open x goal');
    assert.equal(task(root, 'open', 'x', 'goal').status, 0);
    assert.throws(() => closeTask(root, 'x', 'done'), /no user authority/);
    assert.equal(task(root, '--task', 'x', 'close').status, 1);
    userTypes(root, '/rem:task close x');
    assert.equal(task(root, 'close', 'x', 'done').status, 0);
  });

  it('an ordinary prompt that merely mentions the command authorises nothing', () => {
    const root = repo();
    userTypes(root, 'please run /rem:task open x goal for me');
    assert.equal(task(root, 'open', 'x', 'goal').status, 1);
  });
});

describe('the PreToolUse guard (second line) refuses every planted bypass', () => {
  const bash = command => decideTaskGuard({ tool_name: 'Bash', tool_input: { command } }).deny;
  for (const cmd of [
    `node -e "import('./rem/scripts/tasks.mjs').then(m=>m.openTask('.','x','g'))"`,
    'node -e "require(\'./tasks.mjs\').closeTask(1)"',
    'node task.js --task y close',
    'node rem/scripts/task.js --owner me open x goal',
    'cd .claude/tasks/x && echo > TASK.md',
    `python -c "open('.claude/tasks/x/TASK.md','w')"`,
    `python3 -c "import os; os.makedirs('.claude/tasks/x')"`,
    'echo {} > "$TMP/rem-task-authority/abc.json"',
  ]) it(cmd, () => assert.ok(bash(cmd)));

  it('still allows reading tasks and appending through task.js', () => {
    assert.ok(!bash('cat .claude/tasks/x/TASK.md'));
    assert.ok(!bash('node task.js log "closed the open question" --task x'));
    assert.ok(!bash('node task.js decide "keep the close path" --task x'));
  });
});

describe('detection: a TASK.md written around the library', () => {
  it('scope-validate reports a task whose open line lacks the user authority id', () => {
    const root = repo();
    fs.mkdirSync(path.join(root, '.claude', 'tasks', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'tasks', 'x', 'TASK.md'), '---\nname: x\nstatus: open\nopened_by: user\n---\n');
    fs.writeFileSync(path.join(root, '.claude', 'tasks', 'x', 'JOURNAL.md'), '- 2026-10-31 opened: g\n');
    const r = spawnSync(process.execPath, [VALIDATE, '--check'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /task x .*no user authority/);
  });

  it('a task opened through the user command validates clean', () => {
    const root = repo();
    userTypes(root, '/rem:task open x goal');
    assert.equal(task(root, 'open', 'x', 'goal').status, 0);
    const r = spawnSync(process.execPath, [VALIDATE, '--check'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.doesNotMatch(r.stdout, /no user authority/);
  });
});

describe('wiring (planted control)', () => {
  it('the authority hook is registered on UserPromptSubmit', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REM, 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.ok((hooks.UserPromptSubmit || []).some(g => g.hooks.some(h => h.command.includes('task-authority.js'))));
  });
});
