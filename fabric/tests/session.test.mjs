// Tests for engine/session.mjs (the in-process persistent-session registry) and
// engine/codex/session.mjs (persistent codex thread), both exercised with fakes — no real
// claude/codex, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, sendToSession, closeSession, listSessions, getSessionProvider, _resetRegistry,
} from '../engine/session.mjs';
import { openCodexSession } from '../engine/codex/session.mjs';

// ── Fake session handle for registry tests ───────────────────────────
function makeFakeHandle() {
  let turn = 0, closed = false;
  return {
    id: 'native-xyz',
    get turns() { return turn; },
    async send(text) { if (closed) throw new Error('closed'); return { text: `re:${text}`, turn: ++turn }; },
    async close() { closed = true; return 0; },
    _isClosed: () => closed,
  };
}

test('registry: create → send (context turns) → list → close', async () => {
  _resetRegistry();
  const handle = makeFakeHandle();
  const { id, provider, nativeId } = await createSession({ provider: 'codex' }, async () => handle);
  assert.match(id, /^sess-/);
  assert.equal(provider, 'codex');
  assert.equal(nativeId, 'native-xyz');

  const r1 = await sendToSession(id, 'hi');
  assert.equal(r1.text, 're:hi');
  assert.equal(r1.turn, 1);
  const r2 = await sendToSession(id, 'again');
  assert.equal(r2.turn, 2);

  const listed = listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.equal(listed[0].turns, 2);

  const closeRes = await closeSession(id);
  assert.equal(closeRes.id, id);
  assert.equal(closeRes.exitCode, 0);
  assert.ok(handle._isClosed());
  assert.equal(listSessions().length, 0);
});

test('registry: send/close on unknown id rejects; empty prompt rejects', async () => {
  _resetRegistry();
  await assert.rejects(sendToSession('nope', 'x'), /No such session/);
  await assert.rejects(closeSession('nope'), /No such session/);
  const { id } = await createSession({ provider: 'claude' }, async () => makeFakeHandle());
  await assert.rejects(sendToSession(id, '  '), /non-empty/);
});

test('registry: ids are unique across creates', async () => {
  _resetRegistry();
  const a = await createSession({ provider: 'claude' }, async () => makeFakeHandle());
  const b = await createSession({ provider: 'claude' }, async () => makeFakeHandle());
  assert.notEqual(a.id, b.id);
  assert.equal(listSessions().length, 2);
});

test('registry: getSessionProvider returns provider for known id, null for unknown', async () => {
  _resetRegistry();
  const a = await createSession({ provider: 'deepseek' }, async () => makeFakeHandle());
  assert.equal(getSessionProvider(a.id), 'deepseek');
  assert.equal(getSessionProvider('nonexistent'), null);
});

// ── Fake codex app-server client for openCodexSession ────────────────
function makeFakeCodexClient() {
  const handlers = new Map();
  const emit = (m, p) => (handlers.get(m) || []).forEach((h) => h(p));
  return {
    sends: [],
    stopped: false,
    onNotification(m, h) { (handlers.get(m) || handlers.set(m, []).get(m)).push(h); },
    async send(method, params) {
      this.sends.push({ method, params });
      if (method === 'thread/start') { emit('thread/started', { thread: { id: 'thread-1' } }); return { thread: { id: 'thread-1' } }; }
      if (method === 'turn/start') {
        const said = params.input?.[0]?.text || '';
        queueMicrotask(() => {
          // The real app-server echoes the input as a userMessage item BEFORE the answer;
          // extractItemText must skip it so the reply is just the agentMessage.
          emit('item/completed', { item: { type: 'userMessage', content: [{ type: 'text', text: said }] } });
          emit('item/completed', { item: { type: 'agentMessage', text: `codex:${said}` } });
          emit('turn/completed', { usage: { input_tokens: 1, output_tokens: 2 } });
        });
        return { id: 'turn' };
      }
      return {};
    },
    async stop() { this.stopped = true; },
  };
}

test('openCodexSession: multi-turn on one thread, serialized, retains id', async () => {
  const client = makeFakeCodexClient();
  const s = await openCodexSession({ _client: client });
  assert.equal(s.id, 'thread-1');

  const t1 = await s.send('hello');
  assert.equal(t1.text, 'codex:hello');
  assert.equal(t1.turn, 1);
  assert.equal(t1.usage.output_tokens, 2);

  const t2 = await s.send('more');
  assert.equal(t2.text, 'codex:more');
  assert.equal(t2.turn, 2);

  // Every turn reused the same thread (no second thread/start).
  const threadStarts = client.sends.filter((s) => s.method === 'thread/start').length;
  assert.equal(threadStarts, 1);
  const turnStarts = client.sends.filter((s) => s.method === 'turn/start');
  assert.equal(turnStarts.length, 2);
  assert.equal(turnStarts[0].params.threadId, 'thread-1');
  assert.deepEqual(turnStarts[0].params.tools, { disabled: true }); // read-only default

  await s.close();
  assert.ok(client.stopped);
});

test('openCodexSession: write:true enables tools', async () => {
  const client = makeFakeCodexClient();
  const s = await openCodexSession({ _client: client, write: true });
  await s.send('act');
  const turn = client.sends.find((x) => x.method === 'turn/start');
  assert.equal(turn.params.tools, undefined); // tools enabled (not disabled)
  await s.close();
});
