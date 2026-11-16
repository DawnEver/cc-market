// task-bind.test.mjs — rem owns the session binding: the user's `task: <slug>` prompt binds through
// rem's ONE UserPromptSubmit task hook (hooks/task-authority.js), which also records the /rem:task
// authority. The binding file is a contract other tools read (skills/rem/reference/tasks.md § The
// binding file); it is pinned here byte-for-shape. No other process -- no project venv -- takes part.
import { TEST_HOME } from './user-grant.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasksDir, BINDINGS, parseBindPrompt, readSessionBinding } from '../scripts/tasks.mjs';
import { decideTaskGuard } from '../hooks/task-guard.js';

const REM = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(REM, 'hooks', 'task-authority.js');
const TASK = path.join(REM, 'scripts', 'task.js');
const NATIVE_KEYS = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_HOME', 'CODEX_SANDBOX',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'HARNESS_AGENT'];

// The process environment with no harness identity of its own, plus `extra`.
function envWith(extra = {}) {
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME };
  for (const key of NATIVE_KEYS) delete env[key];
  return { ...env, ...extra };
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-bind-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}

const prompt = (root, text, payload = {}, env = envWith()) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ prompt: text, cwd: root, session_id: 's-1', hook_event_name: 'UserPromptSubmit', ...payload }),
  encoding: 'utf8', env,
});

// The user opens `slug` (their /rem:task prompt, then task.js open), returning its authority.
function open(root, slug) {
  prompt(root, `/rem:task open ${slug} "a goal"`);
  const r = spawnSync(process.execPath, [TASK, 'open', slug, 'a goal'],
    { cwd: root, encoding: 'utf8', env: envWith({ CLAUDE_PROJECT_DIR: root }) });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(tasksDir(root), slug, 'TASK.md'), 'utf8').match(/^authority: (\S+)$/m)[1];
}

const bindingFile = (root, session) => path.join(tasksDir(root), BINDINGS, `${session}.json`);
const context = r => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');

describe('the prompt that binds', () => {
  it('is a FIRST line that is exactly `task: <slug>`', () => {
    assert.equal(parseBindPrompt('task: feature-x'), 'feature-x');
    assert.equal(parseBindPrompt('  task:feature-x  \r\nthen the work'), 'feature-x');
    for (const other of ['please task: feature-x', 'task: Feature-X', 'task: feature-x now', 'task:', '/rem:task open x g', '']) {
      assert.equal(parseBindPrompt(other), null, other);
    }
  });
});

describe('rem binds the session on the user\'s `task: <slug>` prompt', () => {
  it('writes the contract file, one per session, and tells the session its PR heads', () => {
    const root = repo();
    const authority = open(root, 'feature-x');
    const r = prompt(root, 'task: feature-x\nfix the thing');
    assert.equal(r.status, 0, r.stderr);
    const record = JSON.parse(fs.readFileSync(bindingFile(root, 's-1'), 'utf8'));
    assert.deepEqual(record, { session: 's-1', task: `feature-x@${authority}` }, 'the contract: exactly these two keys');
    assert.deepEqual(readSessionBinding(root, { session: 's-1' }), { slug: 'feature-x', authority });
    assert.match(context(r), new RegExp(`task feature-x@${authority}`));
    assert.match(context(r), /pr\/feature-x\/<feature>/);
    assert.ok(!fs.existsSync(bindingFile(root, 's-2')), 'PLANTED CONTROL: another session is not bound');
  });

  it('binds from a worktree into the one ledger of the main checkout', () => {
    const root = repo();
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: root });
    const tree = path.join(root, '..', `${path.basename(root)}-wt`);
    spawnSync('git', ['worktree', 'add', '-q', '-b', 'pr/feature-x/a', tree], { cwd: root });
    const authority = open(root, 'feature-x');
    prompt(tree, 'task: feature-x');
    assert.equal(JSON.parse(fs.readFileSync(bindingFile(root, 's-1'), 'utf8')).task, `feature-x@${authority}`);
    assert.ok(!fs.existsSync(path.join(tree, '.claude', 'tasks')), 'nothing lands in the worktree');
  });

  it('a prompt naming no open task binds nothing and names the door', () => {
    const root = repo();
    const r = prompt(root, 'task: never-opened');
    assert.equal(r.status, 0, 'a hook never fails the prompt');
    assert.ok(!fs.existsSync(bindingFile(root, 's-1')));
    assert.match(context(r), /binds nothing/);
    assert.match(context(r), /\/rem:task open never-opened/);
  });

  it('an ordinary prompt binds nothing and says nothing (planted control)', () => {
    const root = repo();
    open(root, 'feature-x');
    const r = prompt(root, 'what does task: feature-x mean?');
    assert.ok(!fs.existsSync(bindingFile(root, 's-1')));
    assert.equal(r.stdout, '');
  });

  it('a session id that is not a plain id binds nothing', () => {
    const root = repo();
    open(root, 'feature-x');
    const r = prompt(root, 'task: feature-x', { session_id: '../escape' });
    assert.ok(!fs.existsSync(path.join(tasksDir(root), BINDINGS)), 'no binding file anywhere');
    assert.match(context(r), /no plain session id/);
  });

  it('a broken project venv cannot stop the binding: no Python takes part', () => {
    // PLANTED: the incident of 2026-11-16 -- a stale venv whose binder refused its own verb blocked every
    // prompt. Here the checkout's interpreter is garbage and PATH holds nothing but node; rem still binds.
    const root = repo();
    const authority = open(root, 'feature-x');
    for (const exe of ['.venv/Scripts/python.exe', '.venv/bin/python']) {
      fs.mkdirSync(path.join(root, path.dirname(exe)), { recursive: true });
      fs.writeFileSync(path.join(root, exe), 'not an interpreter');
    }
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'hooks', 'py.js'), 'process.exit(2);');
    const r = prompt(root, 'task: feature-x', {}, envWith({ PATH: path.dirname(process.execPath), Path: path.dirname(process.execPath) }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(bindingFile(root, 's-1'), 'utf8')).task, `feature-x@${authority}`);
  });

  it('the same hook still records the /rem:task authority (one hook, both jobs)', () => {
    const root = repo();
    open(root, 'feature-x');
    assert.ok(fs.existsSync(path.join(tasksDir(root), 'feature-x', 'TASK.md')));
    const hooks = JSON.parse(fs.readFileSync(path.join(REM, 'hooks', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit;
    const taskHooks = hooks.flatMap(g => g.hooks).filter(h => /task-/.test(h.command));
    assert.deepEqual(taskHooks.map(h => path.basename(h.command.replace(/"/g, ''))), ['task-authority.js']);
  });

  it('an agent still cannot write a binding: the guard refuses it', () => {
    const file = path.join('repo', '.claude', 'tasks', BINDINGS, 's-1.json');
    assert.equal(decideTaskGuard({ tool_name: 'Write', tool_input: { file_path: file } }).deny, true);
    assert.equal(decideTaskGuard({ tool_name: 'Bash', tool_input: { command: `echo {} > ${file}` } }).deny, true);
  });
});

describe('a Codex session binds under its own thread', () => {
  const thread = '0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b';

  it('keys the binding by the thread a git hook in that session reads (CODEX_THREAD_ID), not a parent id', () => {
    const root = repo();
    const authority = open(root, 'feature-x');
    const codex = envWith({ CODEX_HOME: path.join(TEST_HOME, '.codex'), CODEX_THREAD_ID: thread });
    const r = prompt(root, 'task: feature-x', { session_id: 'parent-session' }, codex);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingFile(root, thread), 'utf8')), { session: thread, task: `feature-x@${authority}` });
    assert.ok(!fs.existsSync(bindingFile(root, 'parent-session')), 'PLANTED CONTROL: the parent id is not bound');
  });

  it('reads the thread from the rollout transcript when the environment does not name it', () => {
    const root = repo();
    open(root, 'feature-x');
    const codex = envWith({ CODEX_HOME: path.join(TEST_HOME, '.codex') });
    prompt(root, 'task: feature-x', { session_id: 'parent-session', transcript_path: `/x/rollout-2026-11-16T10-00-00-${thread}.jsonl` }, codex);
    assert.ok(fs.existsSync(bindingFile(root, thread)));
  });
});
