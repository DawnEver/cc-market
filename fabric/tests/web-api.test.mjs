// Tests for engine/web-api.mjs — the local management console's JSON API. Pure handler
// (method, path, body) → {status, body}; HTTP and HTML live in scripts/web.mjs.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-web-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebApi } from '../engine/web-api.mjs';

function fakeDeps() {
  const sessions = new Map();
  let seq = 0;
  return {
    createSession: async (opts) => {
      const id = `sess-w${++seq}`;
      sessions.set(id, { provider: opts.provider, turns: 0, opts });
      return { id, provider: opts.provider, nativeId: null, pid: 100 + seq };
    },
    sendToSession: async (id, text) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`No such session: ${id}`);
      s.turns++;
      return { text: `echo:${text}`, turn: s.turns };
    },
    closeSession: async (id) => { sessions.delete(id); return { id, exitCode: 0 }; },
    listSessions: () => [...sessions.entries()].map(([id, s]) => ({ id, provider: s.provider, turns: s.turns, alive: true, pid: 1 })),
    pingSession: async (id) => ({ id, alive: sessions.has(id), pid: 1 }),
    pingNodes: async () => [{ name: 'G', alive: true, cpu: 32 }],
    reconcile: () => [{ id: 'orphan-1', pidAlive: null }],
  };
}

test('spawn → chat → log → close through the API', async () => {
  const api = createWebApi(fakeDeps());
  const spawn = await api.handle('POST', '/api/sessions', { provider: 'deepseek', model: 'haiku', effort: 'low' });
  assert.equal(spawn.status, 200);
  const id = spawn.body.id;
  const send = await api.handle('POST', `/api/sessions/${id}/send`, { prompt: 'hi' });
  assert.equal(send.body.text, 'echo:hi');
  const log = await api.handle('GET', `/api/sessions/${id}/log`, null);
  assert.equal(log.body.messages.length, 2, 'user + assistant');
  assert.deepEqual(log.body.messages.map((m) => m.role), ['user', 'assistant']);
  const close = await api.handle('POST', `/api/sessions/${id}/close`, {});
  assert.equal(close.status, 200);
});

test('nodes, sessions, reconcile endpoints answer; unknown route 404s; errors carry status 500', async () => {
  const api = createWebApi(fakeDeps());
  assert.equal((await api.handle('GET', '/api/nodes', null)).body[0].name, 'G');
  assert.ok(Array.isArray((await api.handle('GET', '/api/sessions', null)).body));
  assert.equal((await api.handle('GET', '/api/reconcile', null)).body[0].id, 'orphan-1');
  assert.equal((await api.handle('GET', '/api/nope', null)).status, 404);
  const bad = await api.handle('POST', '/api/sessions/sess-missing/send', { prompt: 'x' });
  assert.equal(bad.status, 500);
  assert.match(bad.body.error, /No such session/);
});

test('spawn requires provider; send requires prompt', async () => {
  const api = createWebApi(fakeDeps());
  assert.equal((await api.handle('POST', '/api/sessions', {})).status, 400);
  const s = await api.handle('POST', '/api/sessions', { provider: 'deepseek' });
  assert.equal((await api.handle('POST', `/api/sessions/${s.body.id}/send`, {})).status, 400);
});

test('catalogue lists builtin + configured providers, nodes and efforts', async () => {
  const api = createWebApi({ ...fakeDeps(), catalogue: () => ({
    providers: [{ name: 'claude', models: ['haiku'] }], nodes: ['G'], efforts: ['low'] }) });
  const r = await api.handle('GET', '/api/catalogue', null);
  assert.equal(r.status, 200);
  assert.equal(r.body.providers[0].name, 'claude');
  assert.deepEqual(r.body.nodes, ['G']);
});

test('liveCatalogue probes identity and caches with TTL', async () => {
  const { liveCatalogue, _resetCatalogueCache } = await import('../engine/catalogue.mjs');
  _resetCatalogueCache();
  let t = 1000;
  const cat = liveCatalogue({ _now: () => t, _config: () => ({ nodes: { G: {} } }) });
  assert.equal(cat.probed_at, 1000);
  const claude = cat.providers.find((p) => p.name === 'claude');
  assert.ok('identity' in claude && 'available' in claude && 'version' in claude);
  const codex = cat.providers.find((p) => p.name === 'codex');
  assert.ok(typeof codex.available === 'boolean');
  assert.deepEqual(cat.nodes, ['G']);
  assert.equal(cat.efforts.find((e) => e.name === 'high').tokens, 16384);
  t = 2000;
  assert.equal(liveCatalogue({ _now: () => t, _config: () => ({ nodes: {} }) }).probed_at, 1000, 'cached');
  assert.equal(liveCatalogue({ force: true, _now: () => t, _config: () => ({ nodes: {} }) }).probed_at, 2000, 'force re-probes');
});
