// Tests for shared/spawn-child.mjs. buildChildEnv is pure → tested directly. spawnChild is
// exercised with an injected fake spawn + a real local upstream, so no `claude` or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChildEnv, spawnChild } from '../spawn-child.mjs';
import { clearConfigCache } from '../providers.mjs';

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

// Fake spawn: records argv/env, emits some stdout, closes 0.
function makeFakeSpawn(sink) {
  return (bin, args, spawnOpts) => {
    sink.bin = bin; sink.args = args; sink.env = spawnOpts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', 'child-said-ok');
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
  assert.equal(res.jsonlPath, null, 'no jsonl in normal mode');
  assert.deepEqual(sink.args.slice(0, 4), ['-p', 'hello', '--model', 'claude-haiku-4-5']);
  assert.ok(sink.env.CLAUDE_CONFIG_DIR.includes('config'), 'isolated config dir set');
  assert.equal(sink.env.CLAUDE_CODE_USE_FOUNDRY, '1', 'normal mode = Foundry direct');
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
