// Tests for engine/session.mjs (the in-process persistent-session registry) and
// engine/codex/session.mjs (persistent codex thread), both exercised with fakes — no real
// claude/codex, no network.

// Isolate the session journal: registry events must never pollute the user's real ~/.fabric.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-test-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createSession, sendToSession, closeSession, compactSession, setSessionGoal, goalRunSession, listSessions, getSessionProvider, _resetRegistry, viewSession, resolveSessionDefaults,
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

// ── Identity facts: the registry records the RESOLVED model/effort (sessionDefaults
// applied), so listSessions names what the session runs — never an omitted field.
test('registry records resolved model/effort/project identity', async () => {
  _resetRegistry();
  const cfg = { sessionDefaults: { provider: 'deepseek', model: 'deepseek-v4-flash[1m]', effort: 'max' } };
  // Defaults apply when the spawn omits them (same provider as the default bundle).
  const d = await createSession({ provider: 'deepseek', project: 'motronics', _fabricConfig: cfg }, async () => makeFakeHandle());
  assert.equal(d.model, 'deepseek-v4-flash[1m]');
  assert.equal(d.effort, 'max');
  const [row] = listSessions();
  assert.equal(row.model, 'deepseek-v4-flash[1m]');
  assert.equal(row.effort, 'max');
  assert.equal(row.project, 'motronics');
  // A different provider opts out of the default bundle — nulls, not a wrong-shaped model.
  const c = await createSession({ provider: 'claude', _fabricConfig: cfg }, async () => makeFakeHandle());
  assert.equal(c.model, null);
  assert.equal(listSessions().find((s) => s.id === c.id).effort, null);
});

test('registry: compactSession calls handle.compact and reports compactable as a fact', async () => {
  _resetRegistry();
  const handle = makeFakeHandle();
  handle.compactable = true;
  handle.compact = async () => ({ compacted: true, confirmed: true });
  const { id } = await createSession({ provider: 'codex' }, async () => handle);
  assert.equal(listSessions()[0].compactable, true); // capacity fact on the list
  const res = await compactSession(id);
  assert.deepEqual(res, { id, provider: 'codex', compacted: true, confirmed: true });
  // The handle stays the same id — compaction is in place, not a restart.
  assert.equal(listSessions().length, 1);
});

test('registry: compactSession is an honest NO for backends without native compact', async () => {
  _resetRegistry();
  const { id } = await createSession({ provider: 'claude' }, async () => makeFakeHandle());
  await assert.rejects(compactSession(id), (e) => e.code === 'COMPACT_UNSUPPORTED');
  await assert.rejects(compactSession('nope'), /No such session/);
});

test('registry: setSessionGoal + goalRunSession journal and report goalActive', async () => {
  _resetRegistry();
  const handle = makeFakeHandle();
  handle.goalActive = false;
  handle.setGoal = async (condition) => { handle.goalActive = true; return { condition, active: true, text: 'ok' }; };
  handle.goalRun = async () => ({ text: 'final', turn: 9, turns: 4, state: 'met' });
  const { id } = await createSession({ provider: 'deepseek' }, async () => handle);

  const g = await setSessionGoal(id, 'done when tests pass');
  assert.deepEqual(g, { id, provider: 'deepseek', condition: 'done when tests pass', active: true, text: 'ok' });
  assert.equal(listSessions()[0].goal, true, 'goal fact on the list');

  const r = await goalRunSession(id, { prompt: 'go', maxTurns: 5 });
  assert.deepEqual(r, { id, provider: 'deepseek', text: 'final', turn: 9, turns: 4, state: 'met' });
  assert.equal(listSessions()[0].turns, 9);

  await assert.rejects(setSessionGoal('nope', 'x'), /No such session/);
});

test('registry: goal is an honest NO for backends without it (GOAL_UNSUPPORTED)', async () => {
  _resetRegistry();
  const { id } = await createSession({ provider: 'codex' }, async () => makeFakeHandle());
  await assert.rejects(setSessionGoal(id, 'x'), (e) => e.code === 'GOAL_UNSUPPORTED');
  await assert.rejects(goalRunSession(id, { prompt: 'x' }), (e) => e.code === 'GOAL_UNSUPPORTED');
});

// ── Fake codex app-server client for openCodexSession ────────────────
function makeFakeCodexClient(opts = {}) {
  const handlers = new Map();
  const emit = (m, p) => (handlers.get(m) || []).forEach((h) => h(p));
  return {
    sends: [],
    stopped: false,
    onNotification(m, h) { (handlers.get(m) || handlers.set(m, []).get(m)).push(h); },
    removeNotificationHandler(m, h) { handlers.get(m)?.splice((handlers.get(m) || []).indexOf(h), 1); },
    emit,
    async send(method, params) {
      this.sends.push({ method, params });
      if (method === 'thread/start') { emit('thread/started', { thread: { id: 'thread-1' } }); return { thread: { id: 'thread-1' } }; }
      if (method === 'turn/start') {
        const said = params.input?.[0]?.text || '';
        const reply = () => {
          // The real app-server echoes the input as a userMessage item BEFORE the answer;
          // extractItemText must skip it so the reply is just the agentMessage.
          emit('item/completed', { item: { type: 'userMessage', content: [{ type: 'text', text: said }] } });
          emit('item/completed', { item: { type: 'agentMessage', text: `codex:${said}` } });
          emit('turn/completed', { usage: { input_tokens: 1, output_tokens: 2 } });
        };
        if (opts.turnDelayMs) setTimeout(reply, opts.turnDelayMs);
        else queueMicrotask(reply);
        return { id: 'turn' };
      }
      if (method === 'thread/compact/start') {
        if (opts.compactReject) return Promise.reject(new Error('compact rejected'));
        if (opts.compactConfirm !== false) {
          queueMicrotask(() => emit('context_compacted', { threadId: params.threadId, turnId: 'turn-c' }));
        }
        return { id: 'compact' };
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

test('openCodexSession reports working=true while a turn is in flight, false after', async () => {
  const client = makeFakeCodexClient({ turnDelayMs: 30 });
  const s = await openCodexSession({ _client: client });
  assert.equal(s.working, false, 'idle before any turn');
  const p = s.send('hi');          // do not await — the turn is now queued
  await Promise.resolve();         // let the serialized chain set `current`
  assert.equal(s.working, true, 'working while the turn is generating');
  assert.equal((await p).text, 'codex:hi');
  assert.equal(s.working, false, 'idle once the turn resolves');
  await s.close();
});

test('openCodexSession: write:true enables tools', async () => {
  const client = makeFakeCodexClient();
  const s = await openCodexSession({ _client: client, write: true });
  await s.send('act');
  const turn = client.sends.find((x) => x.method === 'turn/start');
  assert.equal(turn.params.tools, undefined); // tools enabled (not disabled)
  await s.close();
});

// ── Compact: native codex thread/compact/start ──────────────────────
test('codex compact: thread/compact/start on the same thread, awaits confirmation', async () => {
  const client = makeFakeCodexClient();
  const s = await openCodexSession({ _client: client });
  assert.equal(s.compactable, true);
  await s.send('hello'); // one turn first, so compaction has context

  const res = await s.compact();
  assert.deepEqual(res, { compacted: true, confirmed: true });

  const compactSends = client.sends.filter((x) => x.method === 'thread/compact/start');
  assert.equal(compactSends.length, 1);
  assert.equal(compactSends[0].params.threadId, 'thread-1'); // same thread, not a new one

  // The thread still answers after compaction, same id.
  const t = await s.send('after compact');
  assert.equal(t.text, 'codex:after compact');
  assert.equal(s.id, 'thread-1');
  await s.close();
});

test('codex compact: item/completed with a compaction item also confirms', async () => {
  const client = makeFakeCodexClient({ compactConfirm: false });
  const s = await openCodexSession({ _client: client, compactConfirmTimeoutMs: 5000 });
  const p = s.compact();
  // Confirmation via the item path (modern signal; context_compacted is deprecated).
  queueMicrotask(() => client.emit('item/completed', { item: { type: 'context_compaction' } }));
  assert.deepEqual(await p, { compacted: true, confirmed: true });
  await s.close();
});

test('codex compact: no confirmation before the deadline reports confirmed:false, honestly', async () => {
  const client = makeFakeCodexClient({ compactConfirm: false });
  const s = await openCodexSession({ _client: client, compactConfirmTimeoutMs: 25 });
  const res = await s.compact();
  assert.deepEqual(res, { compacted: true, confirmed: false });
  // A late confirmation must not re-fire anything (handlers cleaned up).
  await s.close();
});

test('codex compact: app-server rejection propagates', async () => {
  const client = makeFakeCodexClient({ compactReject: true });
  const s = await openCodexSession({ _client: client });
  await assert.rejects(s.compact(), /compact rejected/);
  await s.close();
});

test('codex compact: serializes with sends — a compact can not land mid-turn', async () => {
  const client = makeFakeCodexClient();
  const s = await openCodexSession({ _client: client });
  // Fire a send and a compact back-to-back; the order of arrival on the wire must
  // match the call order (turn/start before thread/compact/start).
  const sendP = s.send('first');
  const compactP = s.compact();
  await Promise.all([sendP, compactP]);
  const methods = client.sends.map((x) => x.method);
  assert.deepEqual(methods, ['thread/start', 'turn/start', 'thread/compact/start']);
  await s.close();
});

// ── A fake `claude` stream-json child: one persistent process, one result per
// stdin line. Used by the write-session tests below (SR-024/049).
function makeStreamJsonSpawn(record) {
  return (bin, args, opts) => {
    record.spawns++;
    record.bin = bin; record.args = args; record.opts = opts;
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let n = 0;
    child.stdin = {
      write() {
        n++;
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `ok${n}` }] } }) + '\n');
          child.stdout.emit('data', JSON.stringify({ type: 'result' }) + '\n');
        });
      },
      end() { queueMicrotask(() => child.emit('close', 0)); },
    };
    return child;
  };
}
const lastFlag = (args, flag) => (args.lastIndexOf(flag) >= 0 ? args[args.lastIndexOf(flag) + 1] : null);

// ── G0 (2026-08-09): write sessions must spawn the resolved real executable, never a
// `.cmd` shim (spawn EINVAL on Node ≥20.12 / Windows). Mirrors the open-session test.
test('a write session spawns resolveClaudeExe(), not a .cmd shim', async () => {
  const { openProviderSession } = await import('../engine/session.mjs');
  const { resolveClaudeExe } = await import('../engine/spawn-child.mjs');
  const rec = { spawns: 0 };
  const s = await openProviderSession({ provider: 'deepseek', write: true, _spawn: makeStreamJsonSpawn(rec) });
  await s.send('hi');
  await s.close();
  assert.equal(rec.bin, resolveClaudeExe());
  assert.ok(!/\.cmd$/i.test(rec.bin), `bin must not be a .cmd shim, got: ${rec.bin}`);
});

// ── SR-024/049: the O(n²) stateless write path is RETIRED. A write session is the
// persistent stream-json child — ONE spawn for N turns, no accumulated argv prompt.
test('write sessions are persistent: one spawn for many turns, no prompt in argv', async () => {
  const { openProviderSession } = await import('../engine/session.mjs');
  const rec = { spawns: 0 };
  const s = await openProviderSession({ provider: 'deepseek', write: true, _spawn: makeStreamJsonSpawn(rec) });
  const t1 = await s.send('first');
  const t2 = await s.send('second');
  assert.equal(t1.text, 'ok1');
  assert.equal(t2.text, 'ok2');
  assert.equal(rec.spawns, 1, 'a persistent write session must not respawn per turn');
  assert.ok(rec.args.includes('--input-format'), 'write sessions go through the stream-json harness');
  assert.ok(!rec.args.some((a) => /first|second/.test(String(a))), 'the prompt must never ride in argv');
  assert.equal(lastFlag(rec.args, '--permission-mode'), 'bypassPermissions', 'unprofiled write keeps the historic default');
  assert.equal(lastFlag(rec.args, '--allowedTools'), 'Bash,Read,Write,Edit,Glob,Grep');
  await s.close();
});

test('a profiled write session uses the profile policy, never bypassPermissions', async () => {
  const { openProviderSession } = await import('../engine/session.mjs');
  const rec = { spawns: 0 };
  const s = await openProviderSession({
    provider: 'deepseek', write: true, _spawn: makeStreamJsonSpawn(rec),
    profile: { allowedTools: 'Read,Grep' },
  });
  assert.equal(lastFlag(rec.args, '--allowedTools'), 'Read,Grep');
  assert.equal(lastFlag(rec.args, '--permission-mode'), 'default', 'a profile without permissionMode must not widen to bypass');
  await s.close();
});

test('openWriteSession is gone — no compat alias survives', async () => {
  const mod = await import('../engine/session.mjs');
  assert.equal(mod.openWriteSession, undefined);
});

// ── G3: the registry surfaces liveness facts and answers ping without a send.
test('listSessions surfaces pid/alive/lastActivity; pingSession answers facts', async () => {
  const { createSession, listSessions, pingSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  let alive = true, working = true;
  const fakeOpen = async () => ({
    id: 'native-1', pid: 999, get alive() { return alive; }, get working() { return working; }, lastActivity: 123,
    send: async () => ({ text: 'ok', turn: 1 }), close: async () => { alive = false; return 0; },
  });
  const desc = await createSession({ provider: 'deepseek' }, fakeOpen);
  assert.equal(desc.pid, 999);
  const [row] = listSessions();
  assert.equal(row.pid, 999);
  assert.equal(row.alive, true);
  assert.equal(row.working, true, 'working fact flows onto the list descriptor');
  assert.equal(row.lastActivity, 123);
  const ping = await pingSession(desc.id);
  assert.deepEqual({ alive: ping.alive, pid: ping.pid, working: ping.working }, { alive: true, pid: 999, working: true });
  working = false;
  assert.equal(listSessions()[0].working, false, 'working tracks the handle, not a snapshot');
  await closeSession(desc.id);
  await assert.rejects(pingSession(desc.id), /No such session/);
});

// ── G7: the registry and the journal carry usage facts.
test('listSessions surfaces usage; closeSession journals it', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  process.env.FABRIC_JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'fj-usage-'));
  const { journalPath } = await import('../engine/journal.mjs');
  const { createSession, listSessions, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({
    id: 'n1', usage: { input_tokens: 5, output_tokens: 3, cost_usd: 0.001 },
    send: async () => ({ text: 'x', turn: 1 }), close: async () => 0,
  });
  const desc = await createSession({ provider: 'deepseek' }, fakeOpen);
  assert.deepEqual(listSessions()[0].usage, { input_tokens: 5, output_tokens: 3, cost_usd: 0.001 });
  await closeSession(desc.id);
  const rows = readFileSync(journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.find((r) => r.event === 'close').usage, { input_tokens: 5, output_tokens: 3, cost_usd: 0.001 });
});

// ── v2: the registry records cwd, and attachSession adopts an EXISTING remote
// session into this console's registry for chatting.
test('registry records cwd; attachSession registers a remote handle', async () => {
  const { createSession, listSessions, attachSession, sendToSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async (opts) => ({ id: 'n1', pid: 1, send: async () => ({ text: 'x', turn: 1 }), close: async () => 0, cwd: opts.cwd });
  const d = await createSession({ provider: 'deepseek', cwd: '/proj/x' }, fakeOpen);
  assert.equal(listSessions()[0].cwd, '/proj/x');
  // nativeId = the handle's own id — a remote session's id IS the peer's id, so the
  // console can dedup its spawned sessions against the peer's node/status list.
  assert.equal(listSessions()[0].nativeId, 'n1');
  await closeSession(d.id);
  const fakeAttach = async () => ({ id: 'remote-9', send: async (t) => ({ text: `r:${t}`, turn: 1 }), close: async () => 0 });
  const a = await attachSession({ node: 'WS1', remoteId: 'remote-9' }, fakeAttach);
  assert.equal((await sendToSession(a.id, 'ping')).text, 'r:ping');
  assert.equal(listSessions()[0].node, 'WS1');
  await closeSession(a.id);
});

// v3: attach learns the remote session's IDENTITY from the peer (node/view carries
// model/effort/project/cwd/turns/usage now), so an attached handle shows full facts and
// groups under its real project — not a bare "attached, no project".
test('attachSession pulls the remote identity; a peer on old code degrades to nulls', async () => {
  const { listSessions, attachSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const richAttach = async () => ({
    id: 'peer-sess-1',
    view: async () => ({ model: 'deepseek-v4-flash[1m]', effort: 'max', project: 'motronics-studio',
      cwd: 'D:/motronics-studio', turns: 12, pid: 42, usage: { context_tokens: 100 }, compacted: 1 }),
    send: async () => ({ text: 'x', turn: 1 }), close: async () => 0,
  });
  const a = await attachSession({ node: 'WS1', remoteId: 'peer-sess-1' }, richAttach);
  const row = listSessions().find((s) => s.id === a.id);
  assert.equal(row.model, 'deepseek-v4-flash[1m]');
  assert.equal(row.effort, 'max');
  assert.equal(row.project, 'motronics-studio', 'groups under the real project');
  assert.equal(row.cwd, 'D:/motronics-studio');
  assert.equal(row.turns, 12);
  assert.equal(row.compacted, 1);
  assert.equal(row.context_limit, 1_000_000, 'window limit resolved from the model id');
  assert.equal(row.usage.context_tokens, 100);
  await closeSession(a.id);

  // A handle with no view() (older peer) → identity stays null, never fabricated.
  const blindAttach = async () => ({ id: 'peer-sess-2', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const b = await attachSession({ node: 'WS1', remoteId: 'peer-sess-2' }, blindAttach);
  const brow = listSessions().find((s) => s.id === b.id);
  assert.equal(brow.model, null);
  assert.equal(brow.project, null);
  assert.equal(brow.turns, 0);
  await closeSession(b.id);
});

// SR-056: a remote/attached handle DEFINES alive:null until first ping. observedAlive
// must not map that to false ("dead") — null = not-yet-observed, distinct from dead.
test('an un-pinged attached handle reports alive:null, not dead', async () => {
  const { listSessions, attachSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const attach = async () => ({ id: 'r1', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const a = await attachSession({ node: 'WS1', remoteId: 'r1' }, attach);
  const row = listSessions().find((s) => s.id === a.id);
  assert.equal(row.alive, null, 'never pinged → unknown, NOT dead');
  await closeSession(a.id);
});

// SR-056: attached sessions refresh turns/usage/alive from the peer on a cadence, so a
// handle adopted at attach time tracks the peer's running process instead of freezing.
test('attached sessions refresh turns/usage/alive from the peer on a cadence', async () => {
  process.env.FABRIC_ATTACH_REFRESH_MS = '20';
  const { listSessions, attachSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  let pings = 0;
  // The fake must mimic the real remoteHandle.ping(): absorbFacts writes the fresh
  // liveness onto the handle itself (listSessions reads observedAlive(handle)).
  const attach = async () => {
    const handle = { id: 'r1', view: async () => ({ turns: 0 }), send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 };
    handle.ping = async () => {
      pings++;
      handle.alive = true;
      handle.usage = { cost_usd: 0.5, context_tokens: 120 };
      handle.compacted = 2;
      handle.turns = pings;
      return { id: 'r1', turns: pings, usage: handle.usage, compacted: 2, alive: true, lastActivity: 1 };
    };
    return handle;
  };
  const a = await attachSession({ node: 'WS1', remoteId: 'r1' }, attach);
  assert.equal(listSessions().find((s) => s.id === a.id).turns, 0, 'attach-time snapshot first');
  await new Promise((r) => setTimeout(r, 70)); // let a few 20ms ticks land
  const row = listSessions().find((s) => s.id === a.id);
  assert.ok(row.turns > 0, `turns refreshed from the peer (got ${row.turns})`);
  assert.equal(row.compacted, 2);
  assert.equal(row.alive, true, 'alive now observed, not the pre-ping null');
  assert.equal(row.usage.cost_usd, 0.5, 'usage refreshed from the peer');
  delete process.env.FABRIC_ATTACH_REFRESH_MS;
  await closeSession(a.id);
});

// ── SR-040: sends to ONE id are serialized in the registry, so two concurrent
// session_send calls can never interleave on a backend that does not serialize itself.
test('sendToSession serializes per id: concurrent sends run in order, never overlapped', async () => {
  const { createSession, sendToSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const order = [];
  let inFlight = 0, maxInFlight = 0, turn = 0;
  const slow = {
    id: 'n', kind: 'remote',
    async send(text) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${text}`);
      await new Promise((r) => setTimeout(r, text === 'a' ? 40 : 1));
      order.push(`end:${text}`);
      inFlight--;
      return { text: `re:${text}`, turn: ++turn };
    },
    async close() { return 0; },
  };
  const { id } = await createSession({ provider: 'claude' }, async () => slow);
  const [r1, r2] = await Promise.all([sendToSession(id, 'a'), sendToSession(id, 'b')]);
  assert.equal(r1.text, 're:a');
  assert.equal(r2.text, 're:b');
  assert.equal(maxInFlight, 1, 'two sends to one id overlapped');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('a failed send does not wedge the chain for the next send', async () => {
  const { createSession, sendToSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  let n = 0;
  const handle = {
    async send() { if (++n === 1) throw new Error('boom'); return { text: 'ok', turn: n }; },
    async close() { return 0; },
  };
  const { id } = await createSession({ provider: 'claude' }, async () => handle);
  await assert.rejects(sendToSession(id, 'x'), /boom/);
  assert.equal((await sendToSession(id, 'y')).text, 'ok');
});

// ── SR-005/020: honest liveness. `alive` is reported only when the handle observes it.
test('listSessions/pingSession report alive:null when the backend does not observe it', async () => {
  const { createSession, listSessions, pingSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const blind = { id: 'n', kind: 'stateless', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 };
  const { id } = await createSession({ provider: 'deepseek' }, async () => blind);
  const [row] = listSessions();
  assert.equal(row.alive, null, 'a backend with no liveness getter must not claim alive');
  assert.equal(row.kind, 'stateless');
  const ping = await pingSession(id);
  assert.equal(ping.alive, null, 'ping must not fabricate alive:true');
  assert.equal(ping.kind, 'stateless');
});

test('pingSession on an unreachable remote reports alive:false with a reason, never rejects', async () => {
  const { createSession, pingSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const remote = {
    id: 'r', kind: 'remote',
    ping: async () => { const e = new Error('peer gone'); e.code = 'CONNECTION_LOST'; throw e; },
    send: async () => ({ text: 'x', turn: 1 }), close: async () => 0,
  };
  const { id } = await createSession({ provider: 'claude', node: 'WS1' }, async () => remote);
  const res = await pingSession(id);
  assert.equal(res.alive, false);
  assert.equal(res.reason, 'CONNECTION_LOST');
  assert.equal(res.kind, 'remote');
});

// ── SR-018/026/042: codex cannot enforce a profile — a NAMED hole, never a silent one.
test('openProviderSession refuses provider=codex with a profile (PROFILE_UNSUPPORTED)', async () => {
  const { openProviderSession } = await import('../engine/session.mjs');
  await assert.rejects(
    openProviderSession({ provider: 'codex', profile: { allowedTools: 'Read' }, _client: {} }),
    (e) => e.code === 'PROFILE_UNSUPPORTED' && /codex/.test(e.message),
  );
});

test('openProviderSession still opens a codex session when no profile is named', async () => {
  const { openProviderSession } = await import('../engine/session.mjs');
  const s = await openProviderSession({ provider: 'codex', _client: makeFakeCodexClient() });
  assert.equal(s.id, 'thread-1');
  await s.close();
});

// ── SR-022: a named profile resolves against the CALLER's configPath, the same file
// the provider env comes from. Proven through the codex refusal, which names the profile.
test('a named profile resolves from opts.configPath', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { openProviderSession } = await import('../engine/session.mjs');
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'sess-cfg-')), 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({ fabric: { profiles: { auditor: { allowedTools: 'Read' } } } }));
  await assert.rejects(
    openProviderSession({ provider: 'codex', profile: 'auditor', configPath: cfgPath, _client: {} }),
    (e) => e.code === 'PROFILE_UNSUPPORTED' && /auditor/.test(e.message),
  );
  await assert.rejects(
    openProviderSession({ provider: 'codex', profile: 'nosuch', configPath: cfgPath, _client: {} }),
    /unknown spawn profile "nosuch"[\s\S]*auditor/,
  );
});

// ── SR-019/031/032/037: teams.
test('createTeam forwards each worker profile to its session', async () => {
  const { createTeam, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const seen = [];
  const fakeOpen = async (opts) => {
    seen.push({ provider: opts.provider, profile: opts.profile });
    return { id: 'n', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 };
  };
  await createTeam([{ id: 'w1', provider: 'claude', profile: 'auditor' }], fakeOpen);
  assert.deepEqual(seen, [{ provider: 'claude', profile: 'auditor' }]);
});

test('createTeam spawns in parallel and closes the survivors when one worker fails', async () => {
  const { createTeam, listSessions, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const closed = [];
  let started = 0, peak = 0;
  const fakeOpen = async (opts) => {
    started++; peak = Math.max(peak, started);
    await new Promise((r) => setTimeout(r, 5));
    started--;
    if (opts.model === 'bad') throw new Error('spawn refused');
    return { id: opts.model, send: async () => ({ text: 'x', turn: 1 }), close: async () => { closed.push(opts.model); return 0; } };
  };
  await assert.rejects(createTeam([
    { id: 'w1', provider: 'claude', model: 'a' },
    { id: 'w2', provider: 'claude', model: 'bad' },
    { id: 'w3', provider: 'claude', model: 'c' },
  ], fakeOpen), /spawn refused/);
  assert.deepEqual(closed.sort(), ['a', 'c'], 'already-spawned workers must be closed, not leaked');
  assert.deepEqual(listSessions(), [], 'the registry must not keep the orphaned workers');
  assert.ok(peak > 1, 'workers must spawn in parallel');
});

test('getTeamStatus builds ONE session index for the whole team', async () => {
  const { createTeam, getTeamStatus, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({ id: 'n', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const { teamId } = await createTeam(
    [1, 2, 3].map((i) => ({ id: `w${i}`, provider: 'claude' })), fakeOpen);
  let listCalls = 0;
  const status = getTeamStatus(teamId, () => { listCalls++; return []; });
  assert.equal(listCalls, 1, 'one listSessions() per status call, not one per worker');
  assert.equal(status.length, 3);
});

test('teams are journaled on create and close', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  process.env.FABRIC_JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'fj-team-'));
  const { journalPath } = await import('../engine/journal.mjs');
  const { createTeam, closeTeam, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({ id: 'n', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const { teamId } = await createTeam([{ id: 'w1', provider: 'claude' }], fakeOpen);
  await closeTeam(teamId);
  const rows = readFileSync(journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const created = rows.find((r) => r.event === 'team');
  assert.equal(created.team, teamId);
  assert.equal(created.workers.length, 1);
  assert.ok(rows.some((r) => r.event === 'team_close' && r.team === teamId));
});

// ── viewSession: content tail + liveness facts for a local/remote handle; an honest
// content:null for a backend with no viewer (codex), never a fabricated answer.
test('viewSession returns handle content + facts when the handle exposes view()', async () => {
  _resetRegistry();
  const handle = makeFakeHandle();
  handle.kind = 'child';
  handle.pid = 777;
  handle.view = async ({ tailChars }) => ({ content: 'tail'.slice(-tailChars), alive: true, pid: 777, turns: 0, lastActivity: 1, sessionId: 'cli-x', stderrTail: '' });
  const { id } = await createSession({ provider: 'deepseek' }, async () => handle);
  const v = await viewSession(id, { tailChars: 4 });
  assert.equal(v.content, 'tail');
  assert.equal(v.alive, true);
  assert.equal(v.pid, 777);
  assert.equal(v.kind, 'child');
});

test('viewSession is an honest NO for a backend without a content viewer', async () => {
  _resetRegistry();
  const handle = makeFakeHandle(); // no view() — like a codex thread
  handle.kind = 'codex';
  const { id } = await createSession({ provider: 'codex' }, async () => handle);
  const v = await viewSession(id);
  assert.equal(v.content, null);
  assert.match(v.reason, /no content viewer/);
});

test('viewSession on an unknown id rejects', async () => {
  await assert.rejects(() => viewSession('nope'), /No such session/);
});

// ── resolveSessionDefaults: fabric.sessionDefaults is a BUNDLE (provider+model+effort).
// Overriding the provider leaves the default session, so its model/effort no longer apply.
test('resolveSessionDefaults fills provider/model/effort from the config default', () => {
  const cfg = { sessionDefaults: { provider: 'deepseek', model: 'deepseek-v4-flash[1m]', effort: 'max' } };
  assert.deepEqual(resolveSessionDefaults({}, cfg), { provider: 'deepseek', model: 'deepseek-v4-flash[1m]', effort: 'max' });
});

test('resolveSessionDefaults: explicit opts win; a foreign provider drops default model/effort', () => {
  const cfg = { sessionDefaults: { provider: 'deepseek', model: 'deepseek-v4-flash[1m]', effort: 'max' } };
  assert.deepEqual(resolveSessionDefaults({ provider: 'codex' }, cfg), { provider: 'codex', model: null, effort: null });
  assert.deepEqual(resolveSessionDefaults({ provider: 'deepseek', effort: 'low' }, cfg), { provider: 'deepseek', model: 'deepseek-v4-flash[1m]', effort: 'low' });
  // Same default provider, explicit model → explicit wins.
  assert.deepEqual(resolveSessionDefaults({ model: 'deepseek-v4-pro[1m]' }, cfg), { provider: 'deepseek', model: 'deepseek-v4-pro[1m]', effort: 'max' });
});

test('resolveSessionDefaults with no configured default returns nulls', () => {
  assert.deepEqual(resolveSessionDefaults({}, {}), { provider: null, model: null, effort: null });
});

// ── Concurrency hardening: attach idempotency + the unified per-session op chain ──

// Attaching the SAME remote session twice must return the existing registry entry, not
// stack a second record for one remote session (the console double-counts/double-warns).
// node is passed as an OBJECT {host,port,token} — the object path skips the resolveNode
// config lookup, so no config file is needed.
test('attachSession is idempotent: re-attaching the same remote returns the existing entry', async () => {
  const { listSessions, attachSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const node = { host: '10.0.0.9', port: 7677, token: 't' };
  const fakeAttach = async () => ({
    id: 'remote-9',
    view: async () => ({ model: null, turns: 0 }),
    send: async () => ({ text: 'x', turn: 1 }), close: async () => 0,
  });
  const a = await attachSession({ node, remoteId: 'remote-9' }, fakeAttach);
  assert.equal(a.existing, undefined, 'the first attach is a fresh registration');
  const b = await attachSession({ node, remoteId: 'remote-9' }, fakeAttach);
  assert.equal(b.id, a.id, 'the second attach must return the existing entry');
  assert.equal(b.existing, true);
  assert.equal(b.nativeId, 'remote-9');
  assert.equal(listSessions().length, 1, 'one remote session, one registry entry');
});

// Two SIMULTANEOUS attaches race the dedupe scan (both find nothing) — an in-flight
// attach of the same target must be shared so the handle factory runs exactly once.
test('concurrent attachSession calls for the same remote share one handle', async () => {
  const { listSessions, attachSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const node = { host: '10.0.0.9', port: 7677, token: 't' };
  let attachCalls = 0;
  const fakeAttach = async () => {
    attachCalls++;
    await new Promise((r) => setTimeout(r, 20)); // make the overlap real
    return { id: 'remote-9', view: async () => ({ model: null, turns: 0 }), send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 };
  };
  const [a, b] = await Promise.all([
    attachSession({ node, remoteId: 'remote-9' }, fakeAttach),
    attachSession({ node, remoteId: 'remote-9' }, fakeAttach),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(attachCalls, 1, 'two concurrent attaches must share one handle');
  assert.equal(listSessions().length, 1);
});

// A close is GRACEFUL toward in-flight ops: it queues on the per-id chain, so an
// in-flight send completes before the handle is torn down.
test('closeSession waits for an in-flight send (graceful), then closes', async () => {
  const { createSession, sendToSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const order = [];
  let releaseSend;
  const handle = {
    id: 'n',
    async send() {
      order.push('send:start');
      await new Promise((r) => { releaseSend = () => { order.push('send:end'); r(); }; });
      return { text: 'ok', turn: 1 };
    },
    async close() { order.push('close'); return 0; },
  };
  const { id } = await createSession({ provider: 'claude' }, async () => handle);
  const sendP = sendToSession(id, 'a');
  const closeP = closeSession(id);
  // Let the send actually start (and the close queue behind it) before releasing.
  await new Promise((r) => setTimeout(r, 20));
  releaseSend();
  await sendP;
  const closeRes = await closeP;
  assert.equal(closeRes.turns, 1, 'the completed send still counts its turn');
  assert.deepEqual(order, ['send:start', 'send:end', 'close'], 'close must run after the in-flight send completes');
});

// The mirror image: an op that arrives AFTER a close started must reject fast, never
// queue behind the close and fire against a torn-down child.
test('an op after closeSession started rejects immediately (never queues behind the close)', async () => {
  const { createSession, sendToSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  let releaseClose;
  const handle = {
    id: 'n',
    async send() { return { text: 'ok', turn: 1 }; },
    async close() { await new Promise((r) => { releaseClose = r; }); return 0; },
  };
  const { id } = await createSession({ provider: 'claude' }, async () => handle);
  const closeP = closeSession(id);
  await assert.rejects(sendToSession(id, 'late'), /closing/i);
  releaseClose();
  await closeP;
});

// A goal run owns the child until it settles: send/compact/setGoal reject FAST (no
// queueing behind up to 30 minutes of loop), and closeSession is the kill switch —
// it resolves PROMPTLY instead of queueing behind the run.
test('a goal run in flight rejects other ops fast; closeSession is the kill switch', async () => {
  const { createSession, sendToSession, compactSession, setSessionGoal, goalRunSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const order = [];
  let releaseGoalRun;
  const handle = {
    id: 'n', goalActive: true, compactable: true,
    async send() { return { text: 'ok', turn: 1 }; },
    async compact() { return { compacted: true, confirmed: true }; },
    async setGoal(condition) { return { condition, active: true }; },
    async goalRun() {
      order.push('goal:start');
      await new Promise((r) => { releaseGoalRun = r; });
      order.push('goal:end');
      return { text: 'final', turn: 3, turns: 3, state: 'met' };
    },
    async close() { order.push('close'); return 0; },
  };
  const { id } = await createSession({ provider: 'deepseek' }, async () => handle);
  const runP = goalRunSession(id, { prompt: 'go', maxTurns: 5 });
  // These awaits flush microtasks, so the goal run has started before the asserts.
  await assert.rejects(sendToSession(id, 'hi'), /goal run in flight/i);
  await assert.rejects(compactSession(id), /goal run in flight/i);
  await assert.rejects(setSessionGoal(id, 'new goal'), /goal run in flight/i);
  await assert.rejects(goalRunSession(id, { prompt: 'again' }), /goal run in flight/i);
  assert.deepEqual(order, ['goal:start']);
  // The kill switch must NOT queue behind the run — it resolves while the run is blocked.
  await closeSession(id);
  assert.deepEqual(order, ['goal:start', 'close'], 'close must interrupt the run, not wait for it');
  releaseGoalRun(); // let the aborted run settle so nothing dangles
  await runP;
  assert.deepEqual(order, ['goal:start', 'close', 'goal:end']);
});

// ── SR-045: a spawn record names the process that HOLDS the handle, so the layer
// above can route close/ping to the right daemon instead of guessing.
test('spawn events carry the owning process (pid + kind)', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  process.env.FABRIC_JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'fj-owner-'));
  const { journalPath } = await import('../engine/journal.mjs');
  const { createSession, setJournalOwnerKind, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({ id: 'n', send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const lastRow = () => JSON.parse(readFileSync(journalPath(), 'utf8').trim().split('\n').at(-1));
  await createSession({ provider: 'claude' }, fakeOpen);
  assert.deepEqual(lastRow().owner, { pid: process.pid, kind: 'lib' });
  setJournalOwnerKind('mcp');
  await createSession({ provider: 'claude' }, fakeOpen);
  assert.equal(lastRow().owner.kind, 'mcp');
  setJournalOwnerKind('lib');
});
