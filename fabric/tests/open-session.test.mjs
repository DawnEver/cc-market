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
// opts.compact = 'boundary' also emits compact_boundary BEFORE the result when the user
// message is "/compact" (the real CLI's native manual-compact sequence, probed live);
// opts.compact = 'none' omits it (the "refused" case: fresh session / blocking hook).
// Goal mode (opts.goalMet = 'marker'|'never'): when a message carries the goal marker
// instruction, reply with the marker (met) or a plain "still working" (never met).
function makeFakeClaude(sink, opts = {}) {
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
          const reply = () => {
            if (opts.compact === 'boundary' && said === '/compact') {
              child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 30000, post_tokens: 1000 } }) + '\n');
            }
            let text = `echo:${said}`;
            if (said.includes('<<GOAL_COMPLETE>>')) {
              text = opts.goalMet === 'never' ? 'still working on it' : 'work finished <<GOAL_COMPLETE>>';
            }
            child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
            child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success' }) + '\n');
          };
          if (opts.replyDelayMs) setTimeout(reply, opts.replyDelayMs);
          else queueMicrotask(reply);
        }
      },
      end: () => { queueMicrotask(() => child.emit('close', 0)); },
    };
    // The real CLI announces its own session id on the init event; the parser records
    // it for crash-recovery resume. Emit it once, like the real init sequence.
    queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-sess-123' }) + '\n'));
    return child;
  };
}

// Capture spawn args for arg-shape assertions (resume).
function captureSpawn(rec) {
  return (bin, args, opts) => { rec.args = args; return makeFakeClaude(rec.sink)(bin, args, opts); };
}

test('openSession captures the CLI session id (crash-recovery resume) and forwards --resume', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-sessid-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  await s.send('hi'); // init arrives during the first turn
  assert.equal(s.sessionId, 'cli-sess-123');

  // A resume spawn carries --resume <id> so the CLI restores the conversation.
  const rec = { sink: { writes: [] } };
  const rs = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: captureSpawn(rec), _bin: 'fake', resume: 'cli-sess-123' });
  await rs.send('hi');
  const i = rec.args.indexOf('--resume');
  assert.ok(i >= 0, '--resume must be present on a resumed spawn');
  assert.equal(rec.args[i + 1], 'cli-sess-123');
  await s.close(); await rs.close();
});

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

// ── Native compaction (2026-08-10): the CLI compacts on a "/compact" user message and
// emits compact_boundary (trigger: "manual") before the result. Probed live: 30.8k → 1.2k.
test('openSession compact() sends /compact and confirms on compact_boundary', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-compact-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { compact: 'boundary' }), _bin: 'fake' });
  assert.equal(s.compactable, true);

  await s.send('hello'); // a conversation first, so there is context to compact
  const res = await s.compact();

  assert.deepEqual(res, { compacted: true, confirmed: true, text: 'echo:/compact' });
  // The compact went through the SAME serialized user-line channel as any turn.
  assert.match(sink.writes[1], /"content":"\/compact"/);

  // Same session id continues to answer after compaction.
  const t = await s.send('still here');
  assert.equal(t.text, 'echo:still here');
  assert.equal(s.turns, 3);
  await s.close();
});

test('openSession compact() reports confirmed:false when the CLI refuses (no boundary)', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-compact-noboundary-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { compact: 'none' }), _bin: 'fake' });
  await s.send('x');
  const res = await s.compact();
  assert.equal(res.compacted, true);
  assert.equal(res.confirmed, false, 'a result with no boundary is a refused compact, honestly reported');
  await s.close();
});

// ── Goal mode (2026-08-10): fabric-side marker loop. The CLI's native /goal is
// unreachable in fabric's child architecture (refuses under the hook-free policy;
// hangs when hooks are enabled on an isolated config dir) — so setGoal stores the
// condition locally and goalRun iterates until the <<GOAL_COMPLETE>> marker appears
// (or the caps hit). One interaction replaces many: no per-round input needed.
test('openSession setGoal stores the condition locally — no CLI message is sent', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-goal-set-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  const res = await s.setGoal('done when the tests pass');
  assert.deepEqual(res, { condition: 'done when the tests pass', active: true });
  assert.equal(s.goalActive, true);
  assert.equal(sink.writes.length, 0, 'setting a goal must not touch the wire');
  await s.close();
});

test('openSession goal run: marker in the reply → met on the first attempt', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-goal-run-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { goalMet: 'marker' }), _bin: 'fake' });
  await s.setGoal('fix the failing test');
  const res = await s.send('go', 'user', { maxTurns: 5 });
  assert.deepEqual(res, { text: 'work finished <<GOAL_COMPLETE>>', turn: 1, turns: 1, state: 'met' });
  // The trigger carried the marker protocol on the wire.
  assert.match(sink.writes[0], /<<GOAL_COMPLETE>>/);
  assert.equal(s.turns, 1);
  await s.close();
});

test('openSession goal run caps at maxTurns with state capped when the marker never appears', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-goal-cap-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { goalMet: 'never' }), _bin: 'fake' });
  await s.setGoal('never met');
  const res = await s.send('go', 'user', { maxTurns: 2 });
  assert.equal(res.state, 'capped');
  assert.equal(res.turns, 2);
  assert.equal(res.text, 'still working on it', 'the last attempt before the cap');
  // The continuation also carried the marker instruction.
  assert.match(sink.writes[1], /<<GOAL_COMPLETE>>/);
  await s.close();
});

test('openSession goal run times out honestly and does not kill the loop state', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-goal-timeout-'));
  // Slow replies so the attempts outlast the wall-clock cap.
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { goalMet: 'never', replyDelayMs: 25 }), _bin: 'fake' });
  await s.setGoal('long task');
  const res = await s.send('go', 'user', { maxTurns: 50, timeoutMs: 60 });
  assert.equal(res.state, 'timeout');
  assert.equal(s.alive, true, 'a timeout must not kill the child — the work may be worth keeping');
  await s.close();
});

test('openSession goal run without a goal rejects; interjecting mid-run is refused', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-goal-guard-'));
  // Slow replies (replyDelayMs) keep the run in flight while we try to interject.
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink, { goalMet: 'never', replyDelayMs: 40 }), _bin: 'fake' });
  await assert.rejects(s.goalRun('x'), /no goal set/);
  await s.setGoal('never met');
  const runP = s.send('run', 'user', { maxTurns: 50, timeoutMs: 4000 });
  await new Promise((r) => setTimeout(r, 20)); // the first attempt is in flight
  await assert.rejects(s.send('interject'), /goal run is in flight/);
  const res = await runP;
  assert.equal(res.state, 'capped');
  await s.close();
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

// A fake child answering every turn with one assistant line plus a `result` event
// carrying the given fields — the usage-accounting fixture.
function resultFake(resultExtra) {
  return () => {
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
            child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', ...resultExtra }) + '\n');
          });
        }
      },
      end: () => { queueMicrotask(() => child.emit('close', 0)); },
    };
    return child;
  };
}

// ── G7: usage facts accumulate on the handle from stream-json result events.
test('openSession accumulates usage/cost facts across turns', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-usage-'));
  const fake = resultFake({
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 1000 },
  });
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: fake, _bin: 'fake' });
  await s.send('one');
  await s.send('two');
  // SR-012: cache tokens are usually the DOMINANT input term; dropping them makes any
  // budget built on input_tokens a systematic undercount that grows with session length.
  assert.deepEqual(s.usage, {
    input_tokens: 200, output_tokens: 40,
    cache_creation_input_tokens: 600, cache_read_input_tokens: 2000,
    total_input_tokens: 2800, cost_usd: 0.02, partial: false,
  });
  await s.close();
});

// SR-012: a result event with NO usage block means the totals are missing a turn — say so
// rather than reporting a total that quietly under-counts.
test('a result event without usage marks the totals partial', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-partial-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: resultFake({}), _bin: 'fake' });
  await s.send('one');
  assert.equal(s.usage.partial, true);
  assert.equal(s.usage.total_input_tokens, 0);
  await s.close();
});

// ── SR-008: the stderr tail reaches an Error message, the MCP tool result and the
// journal (session.mjs journals e.message on loss). A child that spills its provider
// credentials on a startup failure must not leak them through that path.
test('the stderr tail redacts secret env values before it reaches an Error', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-scrub-'));
  const secret = 'sk-live-DEADBEEF0123456789';
  const cfg = join(mkdtempSync(join(tmpdir(), 'opensess-scrub-')), 'reg.json');
  writeFileSync(cfg, JSON.stringify({ 'env:deepseek': {
    CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://x/anthropic',
    ANTHROPIC_FOUNDRY_API_KEY: secret, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ds-flash',
  } }));
  clearConfigCache();
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = {
      write: () => queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from(`auth failed for key ${secret} at https://x\n`));
        child.emit('close', 1);
      }),
      end: () => {},
    };
    return child;
  };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: cfg, _spawn: fake, _bin: 'fake' });
  const err = await s.send('hi').then(() => null, (e) => e);
  assert.ok(err, 'the turn must reject');
  assert.ok(!err.message.includes(secret), `the key leaked into the error: ${err.message}`);
  assert.match(err.message, /\[redacted\]/);
  assert.match(err.message, /auth failed for key/, 'the diagnostic itself survives');
  assert.ok(!s.stderrTail().includes(secret), 'the exposed tail accessor is scrubbed too');
});

// SR-008: STDERR_TAIL_BYTES is a BYTE budget, and concatenating Buffers via string
// coercion decoded each chunk at an arbitrary boundary, corrupting multibyte UTF-8.
test('the stderr tail is bounded in bytes and never tears a multibyte character', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-tail-'));
  let emit;
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    emit = (b) => child.stderr.emit('data', b);
    return child;
  };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: fake, _bin: 'fake' });
  // A 3-byte character split across two chunks — string coercion would yield mojibake.
  const euro = Buffer.from('€', 'utf8');
  emit(Buffer.from('start ')); emit(euro.subarray(0, 1)); emit(euro.subarray(1)); emit(Buffer.from(' end'));
  assert.equal(s.stderrTail(), 'start € end');

  emit(Buffer.from('x'.repeat(9000)));
  assert.ok(Buffer.byteLength(s.stderrTail(), 'utf8') <= 4096, 'the cap is a byte cap, as the name says');
});

// ── SR-034: openSession's own tmp runDir (config dir, observe http.jsonl, transcript)
// leaked one directory per session, forever.
test('close() removes a fabric-created tmp runDir but never a caller-supplied one', async () => {
  const { existsSync } = await import('node:fs');
  const sink = { writes: [] };
  const own = mkdtempSync(join(tmpdir(), 'fabric-session-'));
  const s1 = await openSession({ provider: 'deepseek', runDir: own, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  await s1.close();
  assert.equal(existsSync(own), false, 'fabric made this dir, fabric reclaims it');

  const theirs = mkdtempSync(join(tmpdir(), 'os-caller-'));
  const s2 = await openSession({ provider: 'deepseek', runDir: theirs, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  await s2.close();
  assert.equal(existsSync(theirs), true, 'a caller-supplied dir is not ours to delete');
});

// ── SR-052: `closed` is only set on close/error. A child killed out of band still has a
// writable stdin pipe, so the turn hangs — and the serialized chain bricks every later
// caller. An abandoned turn leaves the conversation state unknowable, so the session dies.
test('send({timeoutMs}) rejects with TURN_TIMEOUT and kills the session', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'os-timeout-'));
  let killed = 0;
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} }; // accepts the turn, never answers
    child.kill = () => { killed++; queueMicrotask(() => child.emit('close', null)); };
    return child;
  };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: fake, _bin: 'fake' });
  const err = await s.send('hi', 'user', { timeoutMs: 60 }).then(() => null, (e) => e);
  assert.equal(err?.code, 'TURN_TIMEOUT');
  assert.equal(killed, 1, 'the child is killed — an abandoned turn leaves state unknowable');
  assert.equal(s.alive, false);
  await assert.rejects(s.send('again'), /closed/, 'later sends fail fast instead of hanging on the chain');
});

test('send has no timeout by default', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-notimeout-'));
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: makeFakeClaude(sink), _bin: 'fake' });
  const r = await s.send('hello');
  assert.equal(r.text, 'echo:hello');
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

// effort reaches the child env as a thinking budget.
test('openSession applies effort to the child env', async () => {
  const sink = { writes: [] };
  const runDir = mkdtempSync(join(tmpdir(), 'os-effort-'));
  let seenEnv = null;
  const capture = (bin, args, opts) => { seenEnv = opts.env; return makeFakeClaude(sink)(bin, args, opts); };
  const s = await openSession({ provider: 'deepseek', runDir, configPath: fixture(), _spawn: capture, _bin: 'fake', effort: 'high' });
  await s.close();
  assert.equal(seenEnv.MAX_THINKING_TOKENS, '16384');
});

// Native claude authenticates via the user's real config dir (OAuth credentials);
// overriding CLAUDE_CONFIG_DIR to a fresh dir logged every native session out
// (observed live: "Not logged in - Please run /login").
test('native claude keeps the real CLAUDE_CONFIG_DIR; API providers get isolation', async () => {
  const sink = { writes: [] };
  let envs = [];
  const capture = (bin, args, opts) => { envs.push(opts.env); return makeFakeClaude(sink)(bin, args, opts); };
  const s1 = await openSession({ provider: 'claude', runDir: mkdtempSync(join(tmpdir(), 'os-nat-')), _spawn: capture, _bin: 'fake' });
  await s1.close();
  assert.ok(!('CLAUDE_CONFIG_DIR' in envs[0]) || envs[0].CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR,
    'native claude must not be re-homed away from its credentials');
  const s2 = await openSession({ provider: 'deepseek', runDir: mkdtempSync(join(tmpdir(), 'os-api-')), configPath: fixture(), _spawn: capture, _bin: 'fake' });
  await s2.close();
  assert.ok(envs[1].CLAUDE_CONFIG_DIR && envs[1].CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR,
    'API providers keep the isolated config dir');
});
