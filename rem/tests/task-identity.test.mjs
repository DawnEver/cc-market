// task-identity.test.mjs — a task's identity is ONE forge issue labelled task:<slug> on its hosting repo's forge
// (D88, cc-market #44); each machine's ledger is a journal of it. Open opens the issue, close closes it, and
// `task: <slug>` finds the task in this repo's ledger, this machine's other ledgers, or as that issue on the forge.
// The forge is tests/fixtures/fake-forge.mjs (user-grant.mjs points REM_FORGE at it); a "machine" is a machine home.
import { TEST_HOME } from './user-grant.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasksDir } from '../scripts/tasks.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(REM, 'hooks', 'user-prompt.js');
const TASK = path.join(REM, 'scripts', 'task.js');
const NATIVE_KEYS = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SESSION_ID', 'CODEX_HOME', 'CODEX_SANDBOX',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'HARNESS_AGENT'];
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const issuesOnForge = () => JSON.parse(fs.readFileSync(path.join(process.env.REM_FAKE_FORGE, 'issues.json'), 'utf8'));

// A machine: its own machine home (bindings, ledger records); the forge is shared, as a real one is.
function machine() {
  const home = path.join(tmp('rem-machine-'), 'machine-home');
  const env = { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, LAB_COMMONS_HOME: home };
  for (const key of NATIVE_KEYS) delete env[key];
  return env;
}

// A main checkout; `origin` makes two clones on two machines one repo on the forge.
function repo(origin) {
  const root = tmp('rem-id-');
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  if (origin) spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}

const prompt = (env, root, text, session = 's-1') => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ prompt: text, cwd: root, session_id: session, hook_event_name: 'UserPromptSubmit' }),
  encoding: 'utf8', env,
});
const task = (env, root, ...args) => spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: root } });
const context = r => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
const head = (root, slug) => fs.readFileSync(path.join(tasksDir(root), slug, 'TASK.md'), 'utf8');
const issueOf = (root, slug) => head(root, slug).match(/^issue: (\S+)$/m)?.[1];

function open(env, root, slug) {
  prompt(env, root, `/rem:task open ${slug} "a goal"`);
  const r = task(env, root, 'open', slug, 'a goal');
  assert.equal(r.status, 0, r.stderr);
}

describe('a task is one forge issue (D88)', () => {
  it('open opens the task:<slug> issue and records it as `issue:`; close closes that issue', () => {
    const env = machine();
    const root = repo('https://forge.test/fam/open-close.git');
    open(env, root, 'feature-x');
    const url = issueOf(root, 'feature-x');
    const opened = issuesOnForge().filter(i => i.url === url);
    assert.equal(opened.length, 1, 'ONE issue is the identity');
    assert.deepEqual(opened[0].labels, ['task:feature-x']);
    assert.equal(opened[0].state, 'open');
    prompt(env, root, '/rem:task close feature-x');
    const r = task(env, root, 'close', 'feature-x', 'done');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(issuesOnForge().find(i => i.url === url).state, 'closed');
  });

  it('PLANTED: no forge door -- open is refused naming it, and nothing is written', () => {
    const env = { ...machine(), REM_FORGE: '' };
    const root = repo();
    prompt(env, root, '/rem:task open no-door "a goal"');
    const r = task(env, root, 'open', 'no-door', 'a goal');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /REM_FORGE is unset.*dev_lab\.dev\.remhome --install/);
    assert.ok(!fs.existsSync(path.join(tasksDir(root), 'no-door')));
  });
});

describe('`task: <slug>` binds by identity, not by cwd', () => {
  it('PLANTED: a slug with no local task and no issue is refused by name', () => {
    const env = machine();
    const root = repo('https://forge.test/fam/nothing.git');
    const r = prompt(env, root, 'task: ghost-task');
    assert.match(context(r), /binds nothing: no task ghost-task: no ledger of this machine holds it .* no task:ghost-task issue/);
    assert.ok(!fs.existsSync(path.join(env.LAB_COMMONS_HOME, 'state', 'sessions', 's-1.json')));
  });

  it('PLANTED: a session whose cwd is outside the hosting repo still binds, to the hosting ledger', () => {
    const env = machine();
    const host = repo('https://forge.test/fam/host.git');
    const other = repo('https://forge.test/fam/other.git');
    open(env, host, 'cross-repo');
    const r = prompt(env, other, 'task: cross-repo');
    assert.match(context(r), /this session works on task cross-repo@/);
    const record = JSON.parse(fs.readFileSync(path.join(env.LAB_COMMONS_HOME, 'state', 'sessions', 's-1.json'), 'utf8'));
    assert.equal(record.ledger.path, tasksDir(host).replace(/\\/g, '/'), 'the ledger the task was found in, not the cwd\'s');
    assert.ok(!fs.existsSync(path.join(tasksDir(other), 'cross-repo')), 'no second ledger in the cwd repo');
    const logged = spawnSync(process.execPath, [TASK, 'log', 'worked from the other repo'],
      { cwd: other, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: other, CLAUDE_CODE_SESSION_ID: 's-1' } });
    assert.equal(logged.status, 0, logged.stderr);
    assert.match(fs.readFileSync(path.join(tasksDir(host), 'cross-repo', 'JOURNAL.md'), 'utf8'), /worked from the other repo/);
  });

  it('PLANTED: two machines\' ledgers both name the same issue', () => {
    const origin = 'https://forge.test/fam/two-machines.git';
    const [a, b] = [machine(), machine()];
    const [onA, onB] = [repo(origin), repo(origin)];
    open(a, onA, 'shared-work');
    assert.ok(!fs.existsSync(path.join(tasksDir(onB), 'shared-work')), 'machine B has no journal of it yet');
    const r = prompt(b, onB, 'task: shared-work');
    assert.match(context(r), /this session works on task shared-work@issue-\d+/);
    assert.equal(issueOf(onB, 'shared-work'), issueOf(onA, 'shared-work'));
    assert.equal(issuesOnForge().filter(i => i.labels.includes('task:shared-work')).length, 1, 'adopting opens no second issue');
    assert.match(fs.readFileSync(path.join(tasksDir(onB), 'shared-work', 'JOURNAL.md'), 'utf8'), /adopted on this machine from/);
  });

  it('a task whose issue is closed is refused naming that', () => {
    const origin = 'https://forge.test/fam/closed.git';
    const [a, b] = [machine(), machine()];
    const [onA, onB] = [repo(origin), repo(origin)];
    open(a, onA, 'done-work');
    prompt(a, onA, '/rem:task close done-work');
    assert.equal(task(a, onA, 'close', 'done-work', 'done').status, 0);
    assert.match(context(prompt(b, onB, 'task: done-work')), /task done-work was closed: its issue .* is not open/);
  });
});
