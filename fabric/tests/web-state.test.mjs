// Tests for web/public/state.js — the console's pure frontend derivations. No DOM, no
// fetch: these are the only functions with "logic" in the console, so they get tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, viewMessages, aggregateFleet, sessionsOf, projectsOf, canDrive, sessionKey, contextStatus } from '../web/public/state.js';

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
