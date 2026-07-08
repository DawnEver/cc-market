// Tests for shared/open-session.mjs — persistent multi-turn via stream-json, exercised
// with a fake child that echoes stream-json events (no real claude, no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSession } from '../open-session.mjs';
import { clearConfigCache } from '../providers.mjs';

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
