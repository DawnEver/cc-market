// codex-app-server.test.mjs — clientInfo resolution for the shared codex client.
// The client identifies itself to the codex app-server by the nearest enclosing
// plugin's .claude-plugin/plugin.json (walk-up from the entry script), so the same
// shared module reports "takeover" or "fabric" depending on which plugin runs it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveClientInfo, withSharedClient } from '../engine/codex/app-server.mjs';

describe('resolveClientInfo', () => {
  it('finds the nearest .claude-plugin/plugin.json walking up', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-ci-'));
    try {
      mkdirSync(join(root, '.claude-plugin'));
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'someplugin', version: '1.2.3' })
      );
      const deep = join(root, 'scripts', 'codex');
      mkdirSync(deep, { recursive: true });
      const info = resolveClientInfo(join(deep, 'entry.mjs'));
      assert.deepEqual(info, { name: 'someplugin', version: '1.2.3' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to cc-market/0.0.0 when no plugin.json is found', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-ci-none-'));
    try {
      const info = resolveClientInfo(join(root, 'entry.mjs'));
      assert.deepEqual(info, { name: 'cc-market', version: '0.0.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a malformed plugin.json and keeps walking up to a valid ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-ci-bad-'));
    try {
      // Valid manifest at the top.
      mkdirSync(join(root, '.claude-plugin'));
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'ancestor', version: '9.9.9' })
      );
      // Nearer manifest is broken JSON.
      const mid = join(root, 'nested');
      mkdirSync(join(mid, '.claude-plugin'), { recursive: true });
      writeFileSync(join(mid, '.claude-plugin', 'plugin.json'), '{ not valid json');
      const deep = join(mid, 'scripts');
      mkdirSync(deep);
      const info = resolveClientInfo(join(deep, 'entry.mjs'));
      assert.deepEqual(info, { name: 'ancestor', version: '9.9.9' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('withSharedClient lock timeout', () => {
  const fakeClient = { fake: true };
  const getClient = async () => fakeClient;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('rejects only the timed-out waiter with the timeout message', async () => {
    let releaseA;
    const holdA = new Promise((r) => { releaseA = r; });
    const a = withSharedClient(() => holdA, { timeout: 5000, _getClient: getClient });

    const b = withSharedClient(() => 'b-done', { timeout: 50, _getClient: getClient });
    await assert.rejects(b, (err) => {
      assert.match(err.message, /Lock acquisition timed out after 50ms/);
      assert.match(err.message, /Pending requests in queue: \d+/);
      assert.match(err.message, /resetSharedClient/);
      return true;
    });

    releaseA('a-done');
    assert.equal(await a, 'a-done');
  });

  it('a subsequent caller still succeeds after a waiter timed out', async () => {
    let releaseA;
    const holdA = new Promise((r) => { releaseA = r; });
    const a = withSharedClient(() => holdA, { timeout: 5000, _getClient: getClient });

    const b = withSharedClient(() => 'b', { timeout: 50, _getClient: getClient });
    await assert.rejects(b, /Lock acquisition timed out/);

    releaseA('a');
    await a;

    // The stale timeout rejection must not leak into the next caller.
    const c = await withSharedClient((client) => {
      assert.equal(client, fakeClient);
      return 'c-done';
    }, { timeout: 5000, _getClient: getClient });
    assert.equal(c, 'c-done');
  });

  it('a waiter timeout does not let a later caller overlap the active holder', async () => {
    const order = [];
    let releaseA;
    const holdA = new Promise((r) => { releaseA = r; });
    const a = withSharedClient(async () => {
      order.push('a-start');
      await holdA;
      order.push('a-end');
      return 'a';
    }, { timeout: 5000, _getClient: getClient });

    const b = withSharedClient(() => 'b', { timeout: 50, _getClient: getClient });
    const bRejected = assert.rejects(b, /Lock acquisition timed out after 50ms/);
    // Wait for B's timeout to fire while A still holds the lock.
    await bRejected;

    // C is enqueued BEFORE A releases — it must not start until A finishes.
    const c = withSharedClient((client) => {
      order.push('c-start');
      assert.equal(client, fakeClient);
      return 'c';
    }, { timeout: 5000, _getClient: getClient });

    await sleep(20); // give C a chance to (wrongly) run
    assert.ok(!order.includes('c-start'), 'C must not start while A holds the lock');

    releaseA();
    assert.equal(await a, 'a');
    assert.equal(await c, 'c');
    assert.deepEqual(order, ['a-start', 'a-end', 'c-start']);
  });

  it('serializes callers FIFO', async () => {
    const order = [];
    const p1 = withSharedClient(async () => { await sleep(30); order.push(1); }, { _getClient: getClient });
    const p2 = withSharedClient(async () => { order.push(2); }, { _getClient: getClient });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, [1, 2]);
  });
});
