// Offline subprocess acceptance: real bundled hooks compete for one temporary checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const remHook = fileURLToPath(new URL('../../rem/hooks/rem-hook.js', import.meta.url));
const reviewHook = fileURLToPath(new URL('../hooks/sharp-review-hook.js', import.meta.url));
const remComplete = fileURLToPath(new URL('../../rem/scripts/rem-session.js', import.meta.url));
const postReview = fileURLToPath(new URL('../scripts/post-review.js', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  fs.mkdirSync(path.join(root, '.claude'));
  for (const name of ['one', 'two', 'three']) fs.writeFileSync(path.join(root, `${name}.md`), name);
  const file = path.join(root, '.claude', '.rem-state.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ hook: { sessions: Object.fromEntries(['memory', 'sibling'].map(key =>
    [key, { sessionKey: key, stopCount: 2, firstStopAt: now - 180000, lastTouched: now }])) } }));
  const state = () => JSON.parse(fs.readFileSync(file));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: '', CODEX_HOME: root, CODEX_THREAD_ID: 'stale' };
  const run = (script, args = [], input = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, windowsHide: true, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
  const stop = (script, thread) => run(script, [], { cwd: root, session_id: 'parent', thread_id: thread, hook_event_name: 'Stop' });
  const finishRem = key => run(remComplete, ['complete', '--session', key, '--request', state().hook.sessions[key].requestId]);
  const finishReview = async () => {
    const pending = state().reviewGate.pending;
    const plan = { schema_version: 1, run_id: 'offline-fixture', started_at: '2026-06-21T10:00:00.000Z', date: '2026-06-21',
      range: 'HEAD', sink: 'report', report: 'output/logs/26/06/21/sharp-review/sharp-review.md', gate_token: pending.token, profiles: [{ key: 'diff', label: 'diff review' }],
      reviewers: [{ name: 'diff', provider: 'codex', status: 'pending' }] };
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan));
    // Synthetic reviewer data exercises persistence, not a real provider/review acceptance claim.
    fs.writeFileSync(path.join(root, 'raw.json'), JSON.stringify({ run_id: plan.run_id, results: [{ name: 'diff', findings: [] }] }));
    const result = await run(postReview, ['--plan', 'plan.json', '--raw', 'raw.json']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(root, 'output', 'logs', '26', '06', '21', 'sharp-review', 'sharp-review.md')));
    assert.deepEqual(state().reviewGate.reviewedHashes, pending.hashes);
    assert.equal(state().reviewGate.pending, null);
  };
  return { root, state, stop, finishRem, finishReview };
}

test('concurrent REM and review hooks dispatch one owner and defer the other until completion', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const [rem, review] = await Promise.all([f.stop(remHook, 'memory'), f.stop(reviewHook, 'review')]);
  assert.equal([rem, review].filter(result => result.code === 2).length, 1, JSON.stringify({ rem, review }));
  assert.ok([rem.code, review.code].every(code => code === 0 || code === 2));
  if (rem.code === 2) {
    assert.equal(f.state().reviewGate?.pending, undefined);
    assert.equal((await f.finishRem('memory')).code, 0);
    assert.equal((await f.stop(reviewHook, 'review')).code, 2);
    await f.finishReview();
  } else {
    assert.equal(f.state().hook.sessions.memory.remPending, undefined);
    await f.finishReview();
    assert.equal((await f.stop(remHook, 'memory')).code, 2);
    assert.equal((await f.finishRem('memory')).code, 0);
  }
});

test('persisted review completion releases the checkout for the next ordinary REM Stop', { timeout: 30000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.stop(reviewHook, 'review')).code, 2);
  assert.equal((await f.stop(remHook, 'memory')).code, 0);
  assert.equal(f.state().hook.sessions.memory.stopCount, 2);
  await f.finishReview();
  assert.equal((await f.stop(remHook, 'memory')).code, 2);
  assert.equal((await f.finishRem('memory')).code, 0);
});

test('concurrent due REM siblings reserve one checkout while keeping separate completion', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const results = await Promise.all(['memory', 'sibling'].map(key => f.stop(remHook, key)));
  assert.equal(results.filter(result => result.code === 2).length, 1);
  const owner = results[0].code === 2 ? 'memory' : 'sibling';
  const deferred = owner === 'memory' ? 'sibling' : 'memory';
  assert.equal(f.state().hook.sessions[deferred].stopCount, 2);
  assert.equal((await f.finishRem(owner)).code, 0);
  assert.equal((await f.stop(remHook, deferred)).code, 2);
  assert.equal(f.state().hook.sessions[owner].remDone, true);
  assert.equal((await f.finishRem(deferred)).code, 0);
});

test('review hook never dispatches a claim whose atomic state write failed', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const file = path.join(f.root, '.claude', '.rem-state.json');
  // Refuse the atomic state write on every OS: a read-only target blocks the rename on
  // Windows, a read-only directory blocks the temp file on POSIX.
  fs.chmodSync(file, 0o444);
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o555);
  const result = await f.stop(reviewHook, 'review');
  fs.chmodSync(path.dirname(file), 0o755);
  fs.chmodSync(file, 0o644);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Dispatch ONE/);
  assert.equal(f.state().reviewGate?.pending, undefined);
});
