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
