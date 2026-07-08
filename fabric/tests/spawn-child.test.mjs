// Tests for engine/spawn-child.mjs. buildChildEnv is pure → tested directly. spawnChild is
// exercised with an injected fake spawn + a real local upstream, so no `claude` or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChildEnv, spawnChild, resolveClaudeExe, clearClaudeExeCache } from '../engine/spawn-child.mjs';
import { clearConfigCache } from '../engine/providers.mjs';

const REG = {
  'env:deepseek': {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_FOUNDRY_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_FOUNDRY_API_KEY: 'sk-real',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
  },
};
function fixture(reg = REG) {
  const p = join(mkdtempSync(join(tmpdir(), 'spawnchild-')), 'reg.json');
  writeFileSync(p, JSON.stringify(reg));
  clearConfigCache();
  return p;
}

test('buildChildEnv normal mode keeps Foundry (direct-connect)', () => {
  const env = buildChildEnv({ provider: 'deepseek', observe: false, configPath: fixture() });
  assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, '1');
  assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test('buildChildEnv observe mode strips Foundry, points at proxy', () => {
  const env = buildChildEnv({ provider: 'deepseek', observe: true, proxyUrl: 'http://127.0.0.1:9', configPath: fixture() });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, undefined, 'Foundry stripped');
  assert.equal(env.ANTHROPIC_FOUNDRY_API_KEY, undefined, 'real key never reaches child');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'fabric-observe-placeholder');
});

test('buildChildEnv observe mode requires proxyUrl', () => {
  assert.throws(() => buildChildEnv({ provider: 'deepseek', observe: true, configPath: fixture() }), /requires proxyUrl/);
});

// Fake spawn: records argv/env, emits stream-json stdout, closes 0.
function makeFakeSpawn(sink) {
  return (bin, args, spawnOpts) => {
    sink.bin = bin; sink.args = args; sink.env = spawnOpts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'child-said-ok', usage: { input_tokens: 3, output_tokens: 4 } }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}

test('spawnChild wires env + args, isolates config dir (normal mode)', async () => {
  const sink = {};
  const runDir = mkdtempSync(join(tmpdir(), 'sc-run-'));
  const res = await spawnChild({
    provider: 'deepseek', prompt: 'hello', model: 'claude-haiku-4-5', runDir,
    configPath: fixture(), _spawn: makeFakeSpawn(sink), _bin: 'fake-claude',
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'child-said-ok');
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 4 }, 'usage returned in argv (short-prompt) mode too');
  assert.equal(res.jsonlPath, null, 'no jsonl in normal mode');
  assert.deepEqual(sink.args.slice(0, 4), ['-p', 'hello', '--output-format', 'stream-json']);
  // Direct-connect API provider: model pinned via env (resolveModel), not --model —
  // the CLI flag would rely on tier-alias env vars; the env pin is exact.
  assert.equal(sink.env.ANTHROPIC_MODEL, 'deepseek-v4-flash');
  assert.ok(!sink.args.includes('--model'));
  assert.ok(sink.env.CLAUDE_CONFIG_DIR.includes('config'), 'isolated config dir set');
  assert.equal(sink.env.CLAUDE_CODE_USE_FOUNDRY, '1', 'normal mode = Foundry direct');
});

test('spawnChild native claude without runDir: no isolation, --model passthrough', async () => {
  const sink = {};
  const res = await spawnChild({
    provider: 'claude', prompt: 'hello', model: 'claude-haiku-4-5',
    configPath: fixture(), _spawn: makeFakeSpawn(sink), _bin: 'fake-claude',
  });
  assert.equal(res.code, 0);
  assert.deepEqual(sink.args.slice(0, 6), ['-p', 'hello', '--output-format', 'stream-json', '--model', 'claude-haiku-4-5']);
  assert.equal(sink.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, 'no isolated config dir');
  assert.equal(res.runDir, null);
});

test('spawnChild prepends systemPrompt to the prompt', async () => {
  const sink = {};
  await spawnChild({
    provider: 'claude', prompt: 'user says', systemPrompt: 'be terse',
    configPath: fixture(), _spawn: makeFakeSpawn(sink), _bin: 'fake-claude',
  });
  assert.equal(sink.args[1], 'be terse\n\n---\n\nuser says');
});

// Fake spawn with writable stdin for stream-json mode.
function makeStdinFakeSpawn(sink, stdoutLines) {
  return (bin, args, spawnOpts) => {
    sink.bin = bin; sink.args = args; sink.env = spawnOpts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      written: '',
      write(d) { this.written += d; sink.stdinWritten = this.written; },
      end() {
        queueMicrotask(() => {
          for (const line of stdoutLines) child.stdout.emit('data', line + '\n');
          child.emit('close', 0);
        });
      },
    };
    return child;
  };
}

test('spawnChild large prompt switches to stream-json stdin and parses output', async () => {
  const sink = {};
  const big = 'x'.repeat(2000);
  const res = await spawnChild({
    provider: 'claude', prompt: big,
    configPath: fixture(),
    _spawn: makeStdinFakeSpawn(sink, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial ' }] } }),
      JSON.stringify({ type: 'result', result: 'final', usage: { input_tokens: 5, output_tokens: 7 } }),
    ]),
    _bin: 'fake-claude',
  });
  assert.ok(sink.args.includes('--input-format') && sink.args.includes('stream-json'));
  const sent = JSON.parse(sink.stdinWritten);
  assert.equal(sent.type, 'user');
  assert.equal(sent.message.content, big);
  assert.equal(res.stdout, 'partial final');
  assert.deepEqual(res.usage, { input_tokens: 5, output_tokens: 7 });
});

test('spawnChild images force stream-json with image blocks', async () => {
  const sink = {};
  await spawnChild({
    provider: 'claude', prompt: 'look',
    images: [{ media_type: 'image/png', data: 'aGk=' }],
    configPath: fixture(),
    _spawn: makeStdinFakeSpawn(sink, [JSON.stringify({ type: 'result', result: 'ok' })]),
    _bin: 'fake-claude',
  });
  const sent = JSON.parse(sink.stdinWritten);
  assert.equal(sent.message.content.length, 2);
  assert.equal(sent.message.content[1].type, 'image');
  assert.equal(sent.message.content[1].source.data, 'aGk=');
});

test('spawnChild onText survives JSON lines split across stdout chunks', async () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'split-text' }] } }) + '\n';
  const chunks = [line.slice(0, 20), line.slice(20), JSON.stringify({ type: 'result', result: ' done' }) + '\n'];
  const fakeSpawn = (bin, args, spawnOpts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write() {},
      end() {
        queueMicrotask(() => {
          for (const c of chunks) child.stdout.emit('data', c);
          child.emit('close', 0);
        });
      },
    };
    return child;
  };
  const seen = [];
  const res = await spawnChild({
    provider: 'claude', prompt: 'x'.repeat(2000),
    configPath: fixture(), _spawn: fakeSpawn, _bin: 'fake-claude',
    onText: (t) => seen.push(t),
  });
  assert.deepEqual(seen, ['split-text', ' done'], 'no line dropped at a chunk boundary');
  assert.equal(res.stdout, 'split-text done');
});

test('spawnChild flushes the onText line buffer on close (final chunk without trailing newline)', async () => {
  const chunks = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'head ' }] } }) + '\n',
    JSON.stringify({ type: 'result', result: 'tail-no-newline' }), // NO trailing \n
  ];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = {
      write() {},
      end() {
        queueMicrotask(() => {
          for (const c of chunks) child.stdout.emit('data', c);
          child.emit('close', 0);
        });
      },
    };
    return child;
  };
  const seen = [];
  const res = await spawnChild({
    provider: 'claude', prompt: 'x'.repeat(2000),
    configPath: fixture(), _spawn: fakeSpawn, _bin: 'fake-claude',
    onText: (t) => seen.push(t),
  });
  assert.deepEqual(seen, ['head ', 'tail-no-newline'], 'tail without newline still reaches onText');
  assert.equal(res.stdout, 'head tail-no-newline');
});

// Fake spawn emitting arbitrary raw stdout text with a given exit code.
function makePlainTextFakeSpawn(text, code) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', text);
      child.emit('close', code);
    });
    return child;
  };
}

test('spawnChild surfaces non-NDJSON stdout on failure (CLI usage error)', async () => {
  const res = await spawnChild({
    provider: 'claude', prompt: 'hello', configPath: fixture(),
    _spawn: makePlainTextFakeSpawn('Error: unknown flag\n', 1), _bin: 'fake-claude',
  });
  assert.equal(res.code, 1);
  assert.ok(res.stdout.includes('Error: unknown flag'), 'raw stdout surfaced when stream-json yields no text');
});

test('spawnChild surfaces non-NDJSON stdout on zero exit too (banner/gateway HTML)', async () => {
  const res = await spawnChild({
    provider: 'claude', prompt: 'hello', configPath: fixture(),
    _spawn: makePlainTextFakeSpawn('Welcome banner, not JSON\n', 0), _bin: 'fake-claude',
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'Welcome banner, not JSON');
});

test('spawnChild streams onText in short-prompt (argv) mode too', async () => {
  const seen = [];
  const res = await spawnChild({
    provider: 'claude', prompt: 'short',
    configPath: fixture(), _spawn: makeFakeSpawn({}), _bin: 'fake-claude',
    onText: (t) => seen.push(t),
  });
  assert.deepEqual(seen, ['child-said-ok']);
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 4 });
});

test('resolveClaudeExe memoizes, honors CLAUDE_CLI_PATH changes, and clearClaudeExeCache resets', () => {
  const saved = process.env.CLAUDE_CLI_PATH;
  try {
    clearClaudeExeCache();
    process.env.CLAUDE_CLI_PATH = '/tmp/claude-a';
    assert.equal(resolveClaudeExe(), '/tmp/claude-a');
    assert.equal(resolveClaudeExe(), '/tmp/claude-a', 'cached');
    process.env.CLAUDE_CLI_PATH = '/tmp/claude-b';
    assert.equal(resolveClaudeExe(), '/tmp/claude-b', 'cache bypassed when CLAUDE_CLI_PATH changes');
    delete process.env.CLAUDE_CLI_PATH;
    const computed = resolveClaudeExe();
    assert.ok(computed && computed !== '/tmp/claude-b', 'recomputes when override removed');
    assert.equal(resolveClaudeExe(), computed, 'computed path is memoized');
    clearClaudeExeCache();
    assert.equal(resolveClaudeExe(), computed, 'still resolves after cache clear');
  } finally {
    clearClaudeExeCache();
    if (saved === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = saved;
  }
});

test('spawnChild observe mode defaults passthroughAuth on for native claude, forwards explicit value', async () => {
  const proxyCalls = [];
  const fakeProxy = async (opts) => {
    proxyCalls.push(opts);
    return { url: 'http://127.0.0.1:9', jsonlPath: null, close: async () => {} };
  };
  const runDir = mkdtempSync(join(tmpdir(), 'sc-pta-'));
  await spawnChild({
    provider: 'claude', prompt: 'hi', runDir, observe: true,
    configPath: fixture(), _spawn: makeFakeSpawn({}), _bin: 'fake-claude',
    _startObserveProxy: fakeProxy,
  });
  assert.equal(proxyCalls[0].passthroughAuth, true, 'native claude defaults passthroughAuth true');
  await spawnChild({
    provider: 'deepseek', prompt: 'hi', runDir, observe: true,
    configPath: fixture(), _spawn: makeFakeSpawn({}), _bin: 'fake-claude',
    _startObserveProxy: fakeProxy,
  });
  assert.equal(proxyCalls[1].passthroughAuth, false, 'static-key provider defaults false');
  await spawnChild({
    provider: 'deepseek', prompt: 'hi', runDir, observe: true, passthroughAuth: true,
    configPath: fixture(), _spawn: makeFakeSpawn({}), _bin: 'fake-claude',
    _startObserveProxy: fakeProxy,
  });
  assert.equal(proxyCalls[2].passthroughAuth, true, 'explicit passthroughAuth forwarded');
});

test('spawnChild rejects when the abort signal fires', async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    spawnChild({
      provider: 'claude', prompt: 'hi', signal: ctl.signal,
      configPath: fixture(), _spawn: makeFakeSpawn({}), _bin: 'fake-claude',
    }),
    /cancelled/i
  );
});

test('spawnChild observe mode starts proxy, points child at it, captures jsonl', async () => {
  // Minimal upstream so the proxy has somewhere to resolve (child never actually calls it).
  const upstream = http.createServer((_, r) => r.end()).listen(0, '127.0.0.1');
  await new Promise((r) => upstream.once('listening', r));
  const port = upstream.address().port;
  const cfg = fixture({ 'env:deepseek': { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'sk-real', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash' } });
  const sink = {};
  const runDir = mkdtempSync(join(tmpdir(), 'sc-obs-'));
  try {
    const res = await spawnChild({
      provider: 'deepseek', prompt: 'hi', runDir, observe: true,
      configPath: cfg, _spawn: makeFakeSpawn(sink), _bin: 'fake-claude',
    });
    assert.match(sink.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/, 'child points at proxy');
    assert.equal(sink.env.CLAUDE_CODE_USE_FOUNDRY, undefined, 'Foundry stripped in observe mode');
    assert.ok(res.jsonlPath && existsSync(res.jsonlPath), 'jsonl path returned + file exists');
  } finally {
    await new Promise((r) => upstream.close(r));
  }
});

// Argv-mode fake emitting caller-supplied stdout lines.
function makeLinesFakeSpawn(sink, lines) {
  return (bin, args, spawnOpts) => {
    sink.bin = bin; sink.args = args; sink.env = spawnOpts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit('data', line + '\n');
      child.emit('close', 0);
    });
    return child;
  };
}

test('spawnChild JSON-shaped error output still falls back to raw stdout', async () => {
  const errLine = JSON.stringify({ error: { message: 'invalid api key' } });
  const res = await spawnChild({
    provider: 'claude', prompt: 'oops',
    configPath: fixture(),
    _spawn: makeLinesFakeSpawn({}, [errLine]),
    _bin: 'fake-claude',
  });
  assert.equal(res.stdout, errLine, 'non-stream-json JSON error is surfaced, not dropped');
});

test('spawnChild valid stream-json with empty result text yields empty stdout, not raw NDJSON', async () => {
  const sink = {};
  const res = await spawnChild({
    provider: 'claude', prompt: 'quiet',
    configPath: fixture(),
    _spawn: makeLinesFakeSpawn(sink, [
      JSON.stringify({ type: 'result', result: '', usage: { input_tokens: 3, output_tokens: 0 } }),
    ]),
    _bin: 'fake-claude',
  });
  assert.equal(res.stdout, '', 'empty model response stays empty');
  assert.deepEqual(res.usage, { input_tokens: 3, output_tokens: 0 });
});

test('spawnChild does not double-count text when result repeats the assistant text', async () => {
  const seen = [];
  const res = await spawnChild({
    provider: 'claude', prompt: 'hi',
    configPath: fixture(),
    onText: (t) => seen.push(t),
    _spawn: makeLinesFakeSpawn({}, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the answer' }] } }),
      JSON.stringify({ type: 'result', result: 'the answer', usage: { input_tokens: 1, output_tokens: 2 } }),
    ]),
    _bin: 'fake-claude',
  });
  assert.equal(res.stdout, 'the answer', 'result text must not be appended on top of assistant text');
  assert.equal(seen.join(''), 'the answer', 'onText must not stream the answer twice');
  assert.deepEqual(res.usage, { input_tokens: 1, output_tokens: 2 });
});
