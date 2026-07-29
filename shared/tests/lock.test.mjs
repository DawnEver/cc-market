// shared/tests/lock.test.mjs — tests for shared/lock.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, statSync } from 'node:fs';
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
  const { withLock, lockFilePath, LockTimeoutError } = await import(lockUrl);

  it('runs fn and returns its value', () => {
    const res = withLock(tmp('basic'), () => 42);
    assert.equal(res, 42);
  });

  it('creates the lockfile in a device-local dir during fn and removes it after', () => {
    const target = tmp('visible');
    const file = lockFilePath(target);
    assert.ok(!file.startsWith(tmpDir), 'lockfile must NOT live next to the synced target');
    let heldDuring;
    withLock(target, () => { heldDuring = existsSync(file); });
    assert.equal(heldDuring, true);
    assert.equal(existsSync(file), false);
  });

  it('releases the lock when fn throws', () => {
    const target = tmp('throwing');
    assert.throws(() => withLock(target, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(lockFilePath(target)), false);
  });

  it('writes pid+timestamp+token into the lockfile', () => {
    const target = tmp('content');
    let raw;
    withLock(target, () => {
      raw = readFileSync(lockFilePath(target), 'utf8');
    });
    const parsed = JSON.parse(raw);
    assert.equal(parsed.pid, process.pid);
    assert.ok(parsed.at > 0);
    assert.ok(parsed.token && parsed.token.length >= 8);
  });

  it('is reentrant for the same path within one process', () => {
    const target = tmp('reentrant');
    const res = withLock(target, () => withLock(target, () => 'nested'));
    assert.equal(res, 'nested');
    assert.equal(existsSync(lockFilePath(target)), false);
  });

  it('steals a stale lock', () => {
    const target = tmp('stale');
    const file = lockFilePath(target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 999999, at: 0, token: 'dead' }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(file, old, old);
    const start = Date.now();
    const res = withLock(target, () => 'stolen', { staleMs: 60000 });
    assert.equal(res, 'stolen');
    assert.ok(Date.now() - start < 1000, 'steal should be immediate');
    assert.equal(existsSync(file), false);
  });

  it('throws LockTimeoutError by default when the lock is held (fail-closed)', () => {
    const target = tmp('held-throw');
    const file = lockFilePath(target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now(), token: 'other' }));
    const start = Date.now();
    assert.throws(
      () => withLock(target, () => 'never', { staleMs: 60000, retryMs: 20, timeoutMs: 150 }),
      (err) => err.code === 'LOCK_TIMEOUT' && err instanceof LockTimeoutError
    );
    assert.ok(Date.now() - start < 2000, 'must not hang');
    // Foreign lockfile left in place (we never acquired it)
    assert.equal(existsSync(file), true);
  });

  it('proceeds without the lock after timeout when onTimeout: proceed (hook policy)', () => {
    const target = tmp('held');
    const file = lockFilePath(target);
    mkdirSync(dirname(file), { recursive: true });
    // Fresh lockfile from "another process" — not stale, never released
    writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now(), token: 'other' }));
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      const start = Date.now();
      const res = withLock(target, () => 'proceeded', { staleMs: 60000, retryMs: 20, timeoutMs: 150, onTimeout: 'proceed' });
      assert.equal(res, 'proceeded');
      assert.ok(Date.now() - start < 2000, 'must not hang');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /proceeding without lock/);
    assert.equal(existsSync(file), true);
  });

  it('does not unlink a lockfile stolen while held (token mismatch)', () => {
    const target = tmp('steal-release');
    const file = lockFilePath(target);
    withLock(target, () => {
      // Simulate a stealer: our lock looked stale, it unlinked and wrote its own
      rmSync(file);
      writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now(), token: 'stealer' }));
    });
    // Our release must NOT have deleted the stealer's lockfile
    assert.equal(existsSync(file), true);
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(cur.token, 'stealer');
  });

  it('renews the lease while held — a >staleMs section is not stealable', () => {
    const target = tmp('renewed');
    const file = lockFilePath(target);
    const staleMs = 300;
    withLock(target, () => {
      // Hold the section well past staleMs, doing nested locked work — each
      // nested acquisition synchronously refreshes this lock's mtime.
      const t0 = Date.now();
      while (Date.now() - t0 < staleMs * 2) {
        withLock(tmp('renewed-nested'), () => {});
        const spin = Date.now();
        while (Date.now() - spin < 15) { /* busy yield-free hold */ }
      }
      // A would-be stealer now checks mtime: it must be fresh
      const age = Date.now() - statSync(file).mtimeMs;
      assert.ok(age < staleMs, `lock mtime stale (${age}ms) — renewal failed`);
    });
  });
});

// SR-030: real cross-process mutual exclusion — two node processes contend on
// the same lock; critical sections must never interleave.
describe('cross-process mutual exclusion', async () => {
  it('two processes never interleave critical sections', async () => {
    const target = tmp('xproc');
    const log = tmp('xproc.log');
    const worker = tmp('xproc-worker.mjs');
    writeFileSync(worker, `
      import { withLock } from ${JSON.stringify(lockUrl)};
      import { appendFileSync } from 'node:fs';
      const [target, log] = process.argv.slice(2);
      for (let i = 0; i < 10; i++) {
        withLock(target, () => {
          appendFileSync(log, 'start-' + process.pid + '-' + i + '\\n');
          const t = Date.now();
          while (Date.now() - t < 10) {} // hold the section
          appendFileSync(log, 'end-' + process.pid + '-' + i + '\\n');
        }, { retryMs: 5, timeoutMs: 30000 });
      }
    `);

    const { spawn } = await import('node:child_process');
    const run = () => new Promise((res, rej) => {
      const child = spawn(process.execPath, [worker, target, log], { windowsHide: true });
      child.on('exit', (code) => code === 0 ? res() : rej(new Error('worker exited ' + code)));
      child.on('error', rej);
    });
    await Promise.all([run(), run()]);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 40);
    for (let i = 0; i < lines.length; i += 2) {
      const a = lines[i], b = lines[i + 1];
      assert.ok(a.startsWith('start-'), `expected start at line ${i}: ${a}`);
      assert.equal(b, 'end-' + a.slice('start-'.length), `interleaved section at lines ${i}-${i + 1}`);
    }
  });
});
