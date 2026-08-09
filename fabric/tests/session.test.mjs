// Tests for engine/session.mjs (the in-process persistent-session registry) and
// engine/codex/session.mjs (persistent codex thread), both exercised with fakes — no real
// claude/codex, no network.

// Isolate the session journal: registry events must never pollute the user's real ~/.fabric.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-test-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  let alive = true;
  const fakeOpen = async () => ({
    id: 'native-1', pid: 999, get alive() { return alive; }, lastActivity: 123,
    send: async () => ({ text: 'ok', turn: 1 }), close: async () => { alive = false; return 0; },
  });
  const desc = await createSession({ provider: 'deepseek' }, fakeOpen);
  assert.equal(desc.pid, 999);
  const [row] = listSessions();
  assert.equal(row.pid, 999);
  assert.equal(row.alive, true);
  assert.equal(row.lastActivity, 123);
  const ping = await pingSession(desc.id);
  assert.deepEqual({ alive: ping.alive, pid: ping.pid }, { alive: true, pid: 999 });
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
  await closeSession(d.id);
  const fakeAttach = async () => ({ id: 'remote-9', send: async (t) => ({ text: `r:${t}`, turn: 1 }), close: async () => 0 });
  const a = await attachSession({ node: 'WS1', remoteId: 'remote-9' }, fakeAttach);
  assert.equal((await sendToSession(a.id, 'ping')).text, 'r:ping');
  assert.equal(listSessions()[0].node, 'WS1');
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
