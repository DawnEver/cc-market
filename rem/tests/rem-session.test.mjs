import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acknowledgementCommand } from '../hooks/rem-hook.js';

test('acknowledgement instructions keep paths and IDs out of executable shell source', () => {
  const path = '/a $(never-run) `literal`/rem-session.js';
  const command = acknowledgementCommand(path, 'session-$(data)', 'request-`data`');
  assert.doesNotMatch(command, /\$\(|`literal`|`data`/);
  const data = /Buffer.from\('([^']+)'/.exec(command)[1];
  assert.deepEqual(JSON.parse(Buffer.from(data, 'base64').toString()), [path, 'complete', '--session', 'session-$(data)', '--request', 'request-`data`']);
});

const script = fileURLToPath(new URL('../scripts/rem-session.js', import.meta.url));
test('completion CLI acknowledges only the matching live request in the host project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  const file = path.join(root, '.claude', '.rem-state.json');
  fs.writeFileSync(file, JSON.stringify({ hook: { sessions: {
    a: { remPending: true, requestId: 'token', requestExpiresAt: Date.now() + 60000 },
    b: { remPending: true, requestId: 'other', requestExpiresAt: Date.now() + 60000 },
  } } }));
  const run = request => spawnSync(process.execPath, [script, 'complete', '--session', 'a', '--request', request], { cwd: root, encoding: 'utf8' });
  assert.equal(run('wrong').status, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).hook.sessions.a.remPending, true);
  assert.equal(run('token').status, 0);
  const state = JSON.parse(fs.readFileSync(file));
  assert.equal(state.hook.sessions.a.remDone, true);
  assert.equal(state.hook.sessions.b.remPending, true);
  assert.equal(run('token').status, 1, 'a completion acknowledgement is not replayable');
});

test('real REM hook processes isolate sibling threads and acknowledge the execution key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-native-siblings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  const file = path.join(root, '.claude', '.rem-state.json');
  fs.writeFileSync(file, JSON.stringify({ hook: { sessions: {
    a: { sessionKey: 'a', stopCount: 1, firstStopAt: Date.now() - 180000, lastTouched: Date.now() },
  } } }));
  const hook = fileURLToPath(new URL('../hooks/rem-hook.js', import.meta.url));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: '', CODEX_HOME: root, CODEX_THREAD_ID: 'stale' };
  const run = (thread, overrides = {}) => spawnSync(process.execPath, [hook], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ session_id: 'parent', thread_id: thread }),
  });
  assert.equal(run('a').status, 0);
  assert.equal(run('b').status, 0);
  const requested = run('a');
  assert.equal(requested.status, 2, requested.stderr);
  let state = JSON.parse(fs.readFileSync(file));
  assert.equal(state.hook.sessions.a.stopCount, 3);
  assert.equal(state.hook.sessions.b.stopCount, 1);
  assert.equal(state.hook.sessions.parent, undefined);
  assert.equal(state.hook.sessions.stale, undefined);
  assert.equal(run(null, { CODEX_THREAD_ID: '' }).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).hook.sessions, state.hook.sessions);
  const completed = spawnSync(process.execPath, [script, 'complete', '--session', 'a', '--request', state.hook.sessions.a.requestId],
    { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(completed.status, 0, completed.stderr);
  state = JSON.parse(fs.readFileSync(file));
  assert.equal(state.hook.sessions.a.remDone, true);
  assert.equal(state.hook.sessions.b.remDone, false);
});

test('completion CLI reports persistence failure instead of acknowledging in-memory completion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-completion-write-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  const file = path.join(root, '.claude', '.rem-state.json');
  fs.writeFileSync(file, JSON.stringify({ hook: { sessions: {
    thread: { remPending: true, requestId: 'request', requestExpiresAt: Date.now() + 60000 },
  } } }));
  fs.mkdirSync(file + '.tmp');
  const result = spawnSync(process.execPath, [script, 'complete', '--session', 'thread', '--request', 'request'],
    { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /completed/);
  assert.equal(JSON.parse(fs.readFileSync(file)).hook.sessions.thread.remPending, true);
});
