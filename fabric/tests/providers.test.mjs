// Unit tests for engine/providers.mjs — provider routing (no network).
// Uses a temp registry file to exercise vanilla + Foundry blocks and model remapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadProviderConfig, loadProviderEnv, resolveModel, resolveModelFromId,
  resolveUpstream, clearConfigCache, anthropicEndpoint,
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
  'env:kimi': {
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_API_KEY: 'sk-kimi-test',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'k3-256k',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'k3[1m]',
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

test('native claude env strips parent ANTHROPIC_* model pins (fable leak regression)', () => {
  // Regression: a parent shell exporting ANTHROPIC_DEFAULT_FABLE_MODEL (e.g. the kimi
  // profile's k3[1m]) leaked into the native-claude child, which then died exit 1 with
  // "selected model (k3) may not exist". Every ANTHROPIC_* routing key must be stripped.
  const saved = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 'k3[1m]';
  try {
    const env = loadProviderEnv('claude', fixture(REG));
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    else process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = saved;
  }
});

test('fable tier resolves from full ids and bare tier words', () => {
  const cfg = loadProviderConfig('kimi', fixture(REG));
  assert.equal(cfg.defaultFable, 'k3[1m]');
  assert.equal(resolveModelFromId(cfg, 'claude-fable-5'), 'k3[1m]');
  assert.equal(resolveModel(cfg, 'fable'), 'k3[1m]');
});

test('unknown provider lists available ones', () => {
  assert.throws(() => loadProviderConfig('nope', fixture(REG)), /Available|not found/);
});

test('tokenStyle records which env var supplied the token', () => {
  // ANTHROPIC_AUTH_TOKEN → Bearer header; ANTHROPIC_API_KEY → x-api-key; Foundry → x-api-key.
  assert.equal(loadProviderConfig('vanilla', fixture(REG)).tokenStyle, 'bearer');
  assert.equal(loadProviderConfig('kimi', fixture(REG)).tokenStyle, 'x-api-key');
  assert.equal(loadProviderConfig('deepseek', fixture(REG)).tokenStyle, 'x-api-key');
  assert.equal(resolveUpstream('vanilla', fixture(REG)).tokenStyle, 'bearer');
});

test('anthropicEndpoint builds the /v1/messages URL Claude Code itself hits', () => {
  // Per-provider: the constructed endpoint must match the live upstream path.
  assert.equal(anthropicEndpoint('https://api.kimi.com/coding/', '/v1/messages'),
    'https://api.kimi.com/coding/v1/messages');
  assert.equal(anthropicEndpoint('https://api.deepseek.com/anthropic', '/v1/messages'),
    'https://api.deepseek.com/anthropic/v1/messages');
  // Base already ending in /v1 must not double up.
  assert.equal(anthropicEndpoint('https://example.test/v1/', '/v1/messages'),
    'https://example.test/v1/messages');
  assert.equal(anthropicEndpoint('https://api.anthropic.com', '/v1/messages'),
    'https://api.anthropic.com/v1/messages');
});
