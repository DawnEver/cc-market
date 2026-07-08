// Unit tests for engine/providers.mjs — provider routing (no network).
// Uses a temp registry file to exercise vanilla + Foundry blocks and model remapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProviderConfig, loadProviderEnv, resolveModel, resolveModelFromId,
  resolveUpstream, clearConfigCache,
} from '../engine/providers.mjs';

function fixture(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'providers-'));
  const p = join(dir, 'claude_env_settings.json');
  writeFileSync(p, JSON.stringify(obj));
  clearConfigCache();
  return p;
}

const REG = {
  'env:deepseek': {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_FOUNDRY_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_FOUNDRY_API_KEY: 'sk-test',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
  },
  'env:vanilla': {
    ANTHROPIC_BASE_URL: 'https://example.test/v1/',
    ANTHROPIC_AUTH_TOKEN: 'tok-abc',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'big-model',
  },
};

test('loadProviderConfig collapses Foundry into normalized shape', () => {
  const cfg = loadProviderConfig('deepseek', fixture(REG));
  assert.equal(cfg.native, false);
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(cfg.token, 'sk-test');
  assert.equal(cfg.defaultHaiku, 'deepseek-v4-flash');
});

test('loadProviderConfig reads vanilla base/token', () => {
  const cfg = loadProviderConfig('vanilla', fixture(REG));
  assert.equal(cfg.baseUrl, 'https://example.test/v1/');
  assert.equal(cfg.token, 'tok-abc');
});

test('claude/codex are native (not proxy-routable)', () => {
  assert.equal(loadProviderConfig('claude').native, true);
  assert.equal(loadProviderConfig('codex').native, true);
  assert.throws(() => resolveUpstream('claude'), /native/);
});

test('resolveModelFromId maps full Claude ids by tier', () => {
  const cfg = loadProviderConfig('deepseek', fixture(REG));
  assert.equal(resolveModelFromId(cfg, 'claude-haiku-4-5-20251001'), 'deepseek-v4-flash');
  assert.equal(resolveModelFromId(cfg, 'claude-opus-4-8'), 'deepseek-v4-pro[1m]');
  assert.equal(resolveModelFromId(cfg, 'claude-sonnet-5'), 'deepseek-v4-pro[1m]');
});

test('resolveModel maps bare tier words', () => {
  const cfg = loadProviderConfig('deepseek', fixture(REG));
  assert.equal(resolveModel(cfg, 'haiku'), 'deepseek-v4-flash');
  assert.equal(resolveModel(cfg, 'opus'), 'deepseek-v4-pro[1m]');
});

test('resolveUpstream trims trailing slash and binds a remapper', () => {
  const up = resolveUpstream('vanilla', fixture(REG));
  assert.equal(up.baseUrl, 'https://example.test/v1'); // trailing slash trimmed
  assert.equal(up.token, 'tok-abc');
  assert.equal(up.resolveModel('claude-opus-4-8'), 'big-model');
});

test('loadProviderEnv strips provider keys then overlays block', () => {
  const env = loadProviderEnv('deepseek', fixture(REG));
  assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, '1');
});

test('unknown provider lists available ones', () => {
  assert.throws(() => loadProviderConfig('nope', fixture(REG)), /Available|not found/);
});
