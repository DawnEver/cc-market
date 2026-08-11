// Tests for web/public/state.js — the console's pure frontend derivations. No DOM, no
// fetch: these are the only functions with "logic" in the console, so they get tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, viewMessages, aggregateFleet, sessionsOf, projectsOf, canDrive, sessionKey, contextStatus, machineWarnings, attentionItems, compareMachines, fleetHealth } from '../web/public/state.js';

test('parseTranscript: turns tee output into messages, trimming blanks', () => {
  const content = '\n[user]\nhello there\n\n[assistant · turn 1]\nHi! How can I help?\nSecond line.\n\n[user]\nmore\n';
  const msgs = parseTranscript(content);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { role: 'user', text: 'hello there' });
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].turn, 1);
  assert.equal(msgs[1].text, 'Hi! How can I help?\nSecond line.');
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[2].text, 'more');
});

test('parseTranscript: human/goal label as user; system/error as system', () => {
  const msgs = parseTranscript('[human]\ninterjection\n[goal]\ntrigger\n[error]\noops\n[system]\nnote\n');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].human, true);
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'system');
  assert.equal(msgs[3].role, 'system');
});

test('parseTranscript: empty/blank transcripts parse to []', () => {
  assert.deepEqual(parseTranscript(''), []);
  assert.deepEqual(parseTranscript(null), []);
  assert.deepEqual(parseTranscript('   '), []);
});

test('viewMessages: a real transcript is the truth; log is a labelled fallback', () => {
  const v = { content: '\n[user]\nhi\n[assistant · turn 1]\nok\n' };
  const { messages, source } = viewMessages(v, [{ role: 'user', text: 'stale' }]);
  assert.equal(source, 'transcript');
  assert.equal(messages.length, 2);
  // codex reports content:null honestly — fall back to the console log, labelled.
  const v2 = { content: null, reason: 'no viewer' };
  const r2 = viewMessages(v2, [{ role: 'user', text: 'local' }]);
  assert.equal(r2.source, 'log');
  assert.equal(r2.reason, 'no viewer');
  assert.equal(r2.messages[0].text, 'local');
});

test('aggregateFleet: alive count, session count and cumulative spend', () => {
  const fleet = [
    { name: 'G', alive: true, console_sessions: [{ id: 'a', usage: { cost_usd: 0.137 } }],
      sessions: [{ id: 'b', nativeId: 'x', usage: { cost_usd: 1.2 } }] },
    { name: 'WS1', alive: true, console_sessions: [], sessions: [{ id: 'c', usage: null }] },
    { name: 'WS2', alive: false, console_sessions: [], sessions: [] },
  ];
  const agg = aggregateFleet(fleet);
  assert.equal(agg.alive, 2);
  assert.equal(agg.total, 3);
  assert.equal(agg.sessions, 3);
  assert.ok(Math.abs(agg.cost - 1.337) < 1e-9, `cost ${agg.cost}`);
});

test('sessionsOf dedups console-owned sessions from the peer list', () => {
  const m = {
    console_sessions: [{ id: 'sess-1', nativeId: 'n1', chattable: true }],
    sessions: [{ id: 'n1' }, { id: 'n2' }],
  };
  const all = sessionsOf(m);
  assert.equal(all.length, 2);
  assert.ok(all.some((s) => s.id === 'sess-1'));
  assert.ok(all.some((s) => s.id === 'n2'));
});

test('projectsOf: registered aliases plus session projects, deduped', () => {
  const m = {
    projects: ['proj-a', 'proj-b'],
    console_sessions: [{ id: 's1', project: 'proj-b' }],
    sessions: [{ id: 's2', project: null }],
  };
  assert.deepEqual(projectsOf(m), ['proj-a', 'proj-b']);
});

test('canDrive: mine, attached, or shared → true; foreign non-shared → false', () => {
  assert.equal(canDrive({ chattable: true }, new Map()), true);
  assert.equal(canDrive({ key: 'G:x', shared: true }, new Map()), true);
  assert.equal(canDrive({ key: 'G:x', shared: false }, new Set(['G:x'])), true);
  assert.equal(canDrive({ key: 'G:x', shared: false }, new Set()), false);
});

test('sessionKey: machine + remote/console id is stable', () => {
  assert.equal(sessionKey('G', { nativeId: 'n1' }), 'G:n1');
  assert.equal(sessionKey('G', { id: 'sess-1' }), 'G:sess-1');
});

test('contextStatus: percentage from latest-turn context vs the model window', () => {
  const cs = contextStatus({ model: 'deepseek-v4-flash[1m]', context_limit: 1_000_000,
    usage: { context_tokens: 250_000 }, compacted: 2 });
  assert.deepEqual(cs, { used: 250_000, limit: 1_000_000, pct: 25, compacted: 2 });
  // after a compact the latest-turn context drops → percentage drops with it
  const post = contextStatus({ model: 'deepseek-v4-flash[1m]', context_limit: 1_000_000,
    usage: { context_tokens: 30_000 }, compacted: 3 });
  assert.equal(post.pct, 3);
});

test('contextStatus: no % when the window is unknown — tokens only, never fabricated', () => {
  assert.equal(contextStatus({ model: 'kimi-for-coding', context_limit: null, usage: { context_tokens: 50_000 } }).pct, null);
  assert.equal(contextStatus({ usage: {} }).pct, null);
  assert.equal(contextStatus({}).pct, null);
});

// ── attention derivations: the Fleet view's needs-attention list ──

test('machineWarnings: dead reports DEAD only; healthy reports nothing', () => {
  assert.deepEqual(machineWarnings({ alive: false }), ['DEAD']);
  assert.deepEqual(machineWarnings({ alive: true, cpu_busy_pct: 12, mem_total_mb: 1000, mem_available_mb: 500, console_sessions: [], sessions: [] }), []);
});

test('machineWarnings: cpu/mem/capacity thresholds', () => {
  const hot = machineWarnings({ alive: true, cpu_busy_pct: 96, mem_total_mb: 1000, mem_available_mb: 80, maxSessions: 64, sessions_count: 64, console_sessions: [], sessions: [] });
  assert.deepEqual(hot, ['cpu 96%', 'mem 8% free', 'capacity 64/64']);
  // just below every threshold → quiet
  assert.deepEqual(machineWarnings({ alive: true, cpu_busy_pct: 89, mem_total_mb: 1000, mem_available_mb: 110, maxSessions: 64, sessions_count: 63, console_sessions: [], sessions: [] }), []);
});

test('attentionItems: dead machine is bad; ctx/dead-session/orphans warn; worst first', () => {
  const fleet = [
    { name: 'G', alive: true, console_sessions: [
        { id: 'a3f9', chattable: true, context_limit: 1000, usage: { context_tokens: 920 } },
        { id: 'dead1', chattable: true, alive: false }], sessions: [] },
    { name: 'WS2', alive: false, error: 'REQUEST_TIMEOUT: peer stuck', console_sessions: [], sessions: [] },
    { name: 'WS1', alive: true, console_sessions: [], sessions: [{ id: 'ok1' }] },
  ];
  const orphans = [{ id: 'orph1', node: 'WS1', pidAlive: true, sessionId: 'x', ts: 1 }];
  const items = attentionItems(fleet, orphans, 'G');
  assert.deepEqual(items.map((i) => i.kind).sort(), ['ctx', 'machine-dead', 'orphans', 'session-dead']);
  assert.equal(items[0].kind, 'machine-dead', 'bad sorts before warn');
  assert.equal(items[0].severity, 'bad');
  const ctx = items.find((i) => i.kind === 'ctx');
  assert.equal(ctx.machine, 'G');
  assert.equal(ctx.session.id, 'a3f9', 'ctx items carry the session so the UI can jump to chat');
  assert.match(ctx.text, /ctx 92%/);
  const orph = items.find((i) => i.kind === 'orphans');
  assert.equal(orph.machine, 'WS1');
  assert.match(orph.text, /1 unaccounted session\(s\) \(1 resumable\)/);
});

test('attentionItems: local orphans resolve to the self machine name', () => {
  const items = attentionItems([], [{ id: 'o1', node: null, pidAlive: false, ts: 1 }], 'G');
  assert.equal(items[0].machine, 'G');
});

test('attentionItems: a healthy fleet has an empty list', () => {
  const fleet = [{ name: 'G', alive: true, cpu_busy_pct: 5, console_sessions: [{ id: 's', usage: {} }], sessions: [] }];
  assert.deepEqual(attentionItems(fleet, []), []);
});

test('uniqueSessions: an attached session counts once across machines (live v4 bug)', () => {
  // The console's attached handle on G and the peer's native session on WS2 are ONE
  // conversation — header counts and attention items must not double it.
  const fleet = [
    { name: 'G', alive: true, console_sessions: [
      { id: 'sess-9-local', nativeId: 'sess-1-msp4md48', provider: 'attached', chattable: true, alive: false, usage: { cost_usd: 1 } }], sessions: [] },
    { name: 'WS2', alive: true, console_sessions: [], sessions: [
      { id: 'sess-1-msp4md48', alive: false, usage: { cost_usd: 1 } }] },
  ];
  const agg = aggregateFleet(fleet);
  assert.equal(agg.sessions, 1, 'counted once');
  assert.equal(agg.cost, 1, 'cost counted once');
  const dead = attentionItems(fleet, []).filter((i) => i.kind === 'session-dead');
  assert.equal(dead.length, 1, 'warns once');
  assert.equal(dead[0].machine, 'G', 'the drivable copy (first in fleet order) wins');
});

test('fleetHealth: the worst severity anywhere wins', () => {
  assert.equal(fleetHealth([]), 'ok');
  assert.equal(fleetHealth([{ severity: 'warn' }]), 'warn');
  assert.equal(fleetHealth([{ severity: 'warn' }, { severity: 'bad' }]), 'bad');
});

test('compareMachines: dead < warned < healthy; self leads within a tier', () => {
  const dead = { name: 'B', alive: false };
  const warned = { name: 'C', alive: true, cpu_busy_pct: 99, console_sessions: [], sessions: [] };
  const self = { name: 'Z', alive: true, self: true, console_sessions: [], sessions: [] };
  const plain = { name: 'A', alive: true, console_sessions: [], sessions: [] };
  const sorted = [plain, self, warned, dead].sort(compareMachines);
  assert.deepEqual(sorted.map((m) => m.name), ['B', 'C', 'Z', 'A']);
});
