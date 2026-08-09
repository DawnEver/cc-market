// Tests for engine/open-session.mjs — persistent multi-turn via stream-json, exercised
// with a fake child that echoes stream-json events (no real claude, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as eventsMod from 'node:events';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSession } from '../engine/open-session.mjs';
import { clearConfigCache } from '../engine/providers.mjs';

function fixture() {
  const p = join(mkdtempSync(join(tmpdir(), 'opensess-')), 'reg.json');
  writeFileSync(p, JSON.stringify({ 'env:deepseek': { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://x/anthropic', ANTHROPIC_FOUNDRY_API_KEY: 'k', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ds-flash' } }));
  clearConfigCache();
  return p;
}

// Fake claude: reads stream-json user lines on stdin; for each, emits an assistant text
// event echoing the input, then a result. Proves the send↔result turn loop + parsing.
function makeFakeClaude(sink) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let sbuf = '';
    child.stdin = {
      write: (line) => {
        sink.writes.push(line);
        sbuf += line;
        let nl;
        while ((nl = sbuf.indexOf('\n')) !== -1) {
          const l = sbuf.slice(0, nl); sbuf = sbuf.slice(nl + 1);
          if (!l.trim()) continue;
          const msg = JSON.parse(l);
          const said = typeof msg.message.content === 'string' ? msg.message.content : '';
          queueMicrotask(() => {
            child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `echo:${said}` }] } }) + '\n');
            child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
          });
        }
      },
      end: () => { queueMicrotask(() => child.emit('close', 0)); },
    };
    return child;
  };
}

test('openSession send() resolves each turn with assistant text', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-run-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });

  const t1 = await s.send('hello');
  assert.equal(t1.text, 'echo:hello');
  assert.equal(t1.turn, 1);

  const t2 = await s.send('again');
  assert.equal(t2.text, 'echo:again');
  assert.equal(t2.turn, 2);
  assert.equal(s.turns, 2);

  // Both user messages were framed as stream-json user lines.
  assert.equal(sink.writes.length, 2);
  assert.match(sink.writes[0], /"type":"user"/);

  await s.close();
});

test('openSession serializes concurrent sends into ordered turns', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-seq-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });

  const [a, b, c] = await Promise.all([s.send('one'), s.send('two'), s.send('three')]);
  assert.deepEqual([a.turn, b.turn, c.turn], [1, 2, 3], 'turns complete in call order');
  assert.deepEqual([a.text, b.text, c.text], ['echo:one', 'echo:two', 'echo:three']);
  await s.close();
});

test('send after close rejects', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-closed-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  await s.close();
  await assert.rejects(s.send('too late'), /closed/);
});

// ── G0 (2026-08-09): the default bin must be the resolved real executable, never a
// `.cmd` shim — Node ≥20.12 rejects .cmd without shell:true (spawn EINVAL), which broke
// every persistent session on Windows while spawn-child (using resolveClaudeExe) worked.
test('openSession default bin is resolveClaudeExe(), not a .cmd shim', async () => {
  const { resolveClaudeExe } = await import('../engine/spawn-child.mjs');
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-bin-'));
  let seenBin = null;
  const capture = (bin, args, opts) => { seenBin = bin; return makeFakeClaude(sink)(bin, args, opts); };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: capture });
  await s.close();
  assert.equal(seenBin, resolveClaudeExe());
  assert.ok(!/\.cmd$/i.test(seenBin), `bin must not be a .cmd shim, got: ${seenBin}`);
});

// The CLI refuses `--print --output-format stream-json` without `--verbose`
// ("requires --verbose", exit 1) — a latent defect on every platform, found live 2026-08-09.
test('openSession passes --verbose (required by --print stream-json)', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-verbose-'));
  let seenArgs = null;
  const capture = (bin, args, opts) => { seenArgs = args; return makeFakeClaude(sink)(bin, args, opts); };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: capture, _bin: 'fake' });
  await s.close();
  assert.ok(seenArgs.includes('--verbose'), `args must include --verbose, got: ${seenArgs.join(' ')}`);
});

// ── G3 (liveness facts): the handle must report pid / alive / lastActivity, and a
// mid-turn child death must carry the stderr tail — "exit 1" with no stderr was the
// exact debugging experience that motivated this (2026-08-09).
test('openSession exposes pid/alive/lastActivity facts', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-facts-'));
  const withPid = (bin, args, opts) => Object.assign(makeFakeClaude(sink)(bin, args, opts), { pid: 4242 });
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: withPid, _bin: 'fake' });
  assert.equal(s.pid, 4242);
  assert.equal(s.alive, true);
  const before = s.lastActivity;
  await s.send('hi');
  assert.ok(s.lastActivity >= before, 'send must bump lastActivity');
  await s.close();
  assert.equal(s.alive, false);
});

test('mid-turn child death rejects with the stderr tail', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-stderr-'));
  const fake = () => {
    const { EventEmitter } = eventsMod;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 7;
    child.stdin = {
      write: () => queueMicrotask(() => {
        child.stderr.emit('data', 'Error: When using --print, blah requires --verbose\n');
        child.emit('close', 1);
      }),
      end: () => {},
    };
    return child;
  };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: fake, _bin: 'fake' });
  await assert.rejects(s.send('hi'), /requires --verbose/);
});

// ── G7: usage facts accumulate on the handle from stream-json result events.
test('openSession accumulates usage/cost facts across turns', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-usage-'));
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let sbuf = '';
    child.stdin = {
      write: (line) => {
        sbuf += line;
        let nl;
        while ((nl = sbuf.indexOf('\n')) !== -1) {
          sbuf = sbuf.slice(nl + 1);
          queueMicrotask(() => {
            child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
            child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 20 } }) + '\n');
          });
        }
      },
      end: () => { queueMicrotask(() => child.emit('close', 0)); },
    };
    return child;
  };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: fake, _bin: 'fake' });
  await s.send('one');
  await s.send('two');
  assert.deepEqual(s.usage, { input_tokens: 200, output_tokens: 40, cost_usd: 0.02 });
  await s.close();
});

// ── Interactive interjection: a human line appended to the inbox is injected into the
// SAME serialized send chain the orchestrator uses — both drive one conversation.
test('interactive session injects inbox lines as human turns', async () => {
  const { appendFileSync } = await import('node:fs');
  const { readFileSync } = await import('node:fs');
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-inter-'));
  const s = await openSession({
    provider: 'deepseek', runDir, configPath: fixture(),
    _spawn: makeFakeClaude(sink), _bin: 'fake', _viewerSpawn: () => {},
    interactive: true, _pollMs: 50,
  });
  await s.send('orchestrator turn');
  appendFileSync(join(runDir, 'inbox.txt'), 'human interjection\n');
  await new Promise((r) => setTimeout(r, 400));
  const sent = sink.writes.join('');
  assert.match(sent, /human interjection/, 'human line must reach the child');
  const transcript = readFileSync(join(runDir, 'transcript.log'), 'utf8');
  assert.match(transcript, /\[human\]/, 'transcript must label the human turn');
  assert.match(transcript, /\[user\]/, 'orchestrator turns keep their label');
  await s.close();
});
