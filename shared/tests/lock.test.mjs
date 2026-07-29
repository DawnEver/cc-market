// shared/tests/lock.test.mjs — tests for shared/lock.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockUrl = pathToFileURL(join(__dirname, '..', 'lock.mjs')).href;

let tmpDir;
function tmp(...parts) { return join(tmpDir, ...parts); }

before(() => {
  tmpDir = join(__dirname, '_tmp_lock_test_' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('withLock', async () => {
  const { withLock } = await import(lockUrl);

  it('runs fn and returns its value', () => {
    const res = withLock(tmp('basic'), () => 42);
    assert.equal(res, 42);
  });

  it('creates the lockfile during fn and removes it after', () => {
    const target = tmp('visible');
    let heldDuring;
    withLock(target, () => { heldDuring = existsSync(target + '.lock'); });
    assert.equal(heldDuring, true);
    assert.equal(existsSync(target + '.lock'), false);
  });

  it('releases the lock when fn throws', () => {
    const target = tmp('throwing');
    assert.throws(() => withLock(target, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(target + '.lock'), false);
  });

  it('writes pid+timestamp into the lockfile', () => {
    const target = tmp('content');
    let raw;
    withLock(target, () => {
      raw = readFileSync(target + '.lock', 'utf8');
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.pid, process.pid);
    assert.ok(parsed.at > 0);
  });

  it('is reentrant for the same path within one process', () => {
    const target = tmp('reentrant');
    const res = withLock(target, () => withLock(target, () => 'nested'));
    assert.equal(res, 'nested');
    assert.equal(existsSync(target + '.lock'), false);
  });

  it('steals a stale lock', () => {
    const target = tmp('stale');
    writeFileSync(target + '.lock', JSON.stringify({ pid: 999999, at: 0 }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(target + '.lock', old, old);
    const start = Date.now();
    const res = withLock(target, () => 'stolen', { staleMs: 60000 });
    assert.equal(res, 'stolen');
    assert.ok(Date.now() - start < 1000, 'steal should be immediate');
    assert.equal(existsSync(target + '.lock'), false);
  });

  it('proceeds without the lock after timeout rather than hanging', () => {
    const target = tmp('held');
    // Fresh lockfile from "another process" — not stale, never released
    writeFileSync(target + '.lock', JSON.stringify({ pid: 999999, at: Date.now() }));
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      const start = Date.now();
      const res = withLock(target, () => 'proceeded', { staleMs: 60000, retryMs: 20, timeoutMs: 150 });
      assert.equal(res, 'proceeded');
      assert.ok(Date.now() - start < 2000, 'must not hang');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /proceeding without lock/);
    // Foreign lockfile left in place (we never acquired it)
    assert.equal(existsSync(target + '.lock'), true);
  });
});
