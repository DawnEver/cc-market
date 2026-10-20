// Unit tests for engine/providers.mjs — the catalogue comes from the provider cache (ai-lab's
// published document), never from fabric's own data; a stale or absent cache is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  loadProviderConfig, loadProviderEnv, resolveModel, resolveModelFromId,
  resolveUpstream, anthropicEndpoint, readCatalogue, listModels, SETUP_REMEDY,
  gitCredentialKey, _setKeySource,
} from '../engine/providers.mjs';
import { providerCacheFixture, fixtureKeySource, CACHE_KEYS, ROW_KEYS } from './fixtures/provider-cache.mjs';
import { readFileSync } from 'node:fs';

_setKeySource(fixtureKeySource());

const REGISTRY = {
  providers: {
    acme: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY' },
    plain: { claudeApiKeyEnv: 'ANTHROPIC_AUTH_TOKEN' },
    tiered: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
};
const fixture = (opts = {}) => providerCacheFixture({ registry: REGISTRY, ...opts }).configPath;

const refusedUnsupported = (fn, pattern) => assert.throws(fn, (e) => e.kind === 'unsupported' && pattern.test(e.message));

test('an absent provider cache is unsupported, naming the remedy', () => {
  const { configPath, cachePath } = providerCacheFixture();
  unlinkSync(cachePath);
  refusedUnsupported(() => loadProviderConfig('acme', configPath), /absent/);
  assert.ok(SETUP_REMEDY.includes('setup'));
  assert.throws(() => readCatalogue(configPath), (e) => e.message.includes(SETUP_REMEDY));
});

test('a cache older than the max age is stale', () => {
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  refusedUnsupported(() => loadProviderConfig('acme', fixture({ generatedAt: old })), /older than 7 d/);
});

test('a cache whose catalogue input changed is stale', () => {
  const { configPath, packaged } = providerCacheFixture({ registry: REGISTRY });
  writeFileSync(packaged, '# edited\n');
  refusedUnsupported(() => readCatalogue(configPath), /changed since it was generated/);
});

test('a cache of another schema_version is stale', () => {
  refusedUnsupported(() => readCatalogue(fixture({ extra: { schema_version: 2 } })), /schema_version 2/);
});

test('an unknown provider is unsupported and lists the catalogue', () => {
  refusedUnsupported(() => loadProviderConfig('nope', fixture()), /not in the catalogue.*known: claude, codex, acme/);
});

test('loadProviderConfig reads the anthropic endpoint and the models from the catalogue row', () => {
  const cfg = loadProviderConfig('acme', fixture());
  assert.equal(cfg.native, false);
  assert.equal(cfg.baseUrl, 'https://api.acme.test/anthropic');
  assert.equal(cfg.defaultHaiku, 'acme-flash');
  assert.equal(cfg.defaultOpus, 'acme-pro[1m]');
});

test('claude/codex are host rows, read without a cache', () => {
  assert.deepEqual(loadProviderConfig('claude', '/nonexistent/x.json'), { native: true, provider: 'claude' });
  assert.deepEqual(loadProviderConfig('codex', '/nonexistent/x.json'), { native: true, provider: 'codex' });
  assert.throws(() => resolveUpstream('claude', '/nonexistent/x.json'), /native/);
});

test('a provider with no anthropic endpoint cannot run a claude child or be observed', () => {
  refusedUnsupported(() => loadProviderEnv('openonly', fixture()), /no anthropic-protocol endpoint/);
  refusedUnsupported(() => resolveUpstream('openonly', fixture()), /no anthropic-protocol endpoint/);
});

test('resolveModelFromId maps full Claude ids by tier', () => {
  const cfg = loadProviderConfig('acme', fixture());
  assert.equal(resolveModelFromId(cfg, 'claude-haiku-4-5-20251001'), 'acme-flash');
  assert.equal(resolveModelFromId(cfg, 'claude-opus-4-8'), 'acme-pro[1m]');
});

test('resolveModel maps bare tier words', () => {
  const cfg = loadProviderConfig('acme', fixture());
  assert.equal(resolveModel(cfg, 'haiku'), 'acme-flash');
  assert.equal(resolveModel(cfg, 'opus'), 'acme-pro[1m]');
});

test('resolveUpstream trims trailing slash and binds a remapper', () => {
  const up = resolveUpstream('plain', fixture());
  assert.equal(up.baseUrl, 'https://plain.test/v1');
  assert.equal(up.tokenStyle, 'bearer');
  assert.equal(up.resolveModel('claude-opus-4-8'), 'big-model');
});

test('loadProviderEnv projects the anthropic endpoint (Claude Code appends /v1) and the models', () => {
  const env = loadProviderEnv('acme', fixture());
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.acme.test/anthropic');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'acme-flash');
  assert.equal(loadProviderEnv('plain', fixture()).ANTHROPIC_BASE_URL, 'https://plain.test');
});

test('native claude env strips parent ANTHROPIC_* model pins (fable leak regression)', () => {
  const saved = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = 't3[1m]';
  try {
    const env = loadProviderEnv('claude', fixture());
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
    else process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = saved;
  }
});

test('fable tier resolves from full ids and bare tier words', () => {
  const cfg = loadProviderConfig('tiered', fixture());
  assert.equal(cfg.defaultFable, 't3[1m]');
  assert.equal(resolveModelFromId(cfg, 'claude-fable-5'), 't3[1m]');
  assert.equal(resolveModel(cfg, 'fable'), 't3[1m]');
  assert.deepEqual([cfg.defaultSonnet, cfg.defaultOpus, cfg.subagent], ['t3-256k', 't3-256k', 't3-256k']);
});

test('tokenStyle follows the registry projection rule claudeApiKeyEnv', () => {
  assert.equal(loadProviderConfig('plain', fixture()).tokenStyle, 'bearer');
  assert.equal(loadProviderConfig('acme', fixture()).tokenStyle, 'x-api-key');
});

test('listModels lists the host rows then the catalogue, or the refusal', () => {
  const out = listModels(fixture());
  assert.match(out, /^claude/);
  assert.match(out, /acme\s+→ https:\/\/api\.acme\.test\/anthropic/);
  const { configPath, cachePath } = providerCacheFixture();
  unlinkSync(cachePath);
  assert.match(listModels(configPath), /absent.*setup/);
});

test('anthropicEndpoint builds the /v1/messages URL Claude Code itself hits', () => {
  assert.equal(anthropicEndpoint('https://api.tiered.test/coding/', '/v1/messages'), 'https://api.tiered.test/coding/v1/messages');
  assert.equal(anthropicEndpoint('https://example.test/v1/', '/v1/messages'), 'https://example.test/v1/messages');
});

test('the key comes from the credential store under the row host and the task username', () => {
  assert.equal(loadProviderEnv('acme', fixture()).ANTHROPIC_API_KEY, 'sk-test');
  assert.equal(loadProviderEnv('acme', fixture(), { task: 'pr-review' }).ANTHROPIC_API_KEY, 'sk-acme-review');
  assert.equal(resolveUpstream('plain', fixture()).token, 'tok-abc');
});

test('a key in the registry file is never read', () => {
  const configPath = fixture({ registry: { providers: { acme: { claudeApiKeyEnv: 'ANTHROPIC_API_KEY', apiKey: 'sk-plaintext' } } } });
  assert.equal(loadProviderEnv('acme', configPath).ANTHROPIC_API_KEY, 'sk-test');
});

test('no stored key is auth, naming the login command; an undeclared task is unsupported', () => {
  assert.throws(() => loadProviderEnv('acme', fixture(), { task: 'nosuch' }), (e) => e.kind === 'unsupported' && /declared: default, pr-review/.test(e.message));
  const restore = _setKeySource(() => null);
  try {
    assert.throws(() => loadProviderEnv('acme', fixture(), { task: 'pr-review' }),
      (e) => e.kind === 'auth' && e.message.includes('python -m ai_lab.auth login acme --task pr-review') && !e.message.includes('sk-'));
  } finally { restore(); }
});

test('gitCredentialKey asks git credential fill with prompts off and reads the password', () => {
  let seen;
  const key = gitCredentialKey('api.acme.test', 'api-key', { _spawnSync: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: 'protocol=https\nhost=api.acme.test\nusername=api-key\npassword=sk-x\n' }; } });
  assert.equal(key, 'sk-x');
  assert.equal(seen.cmd, 'git');
  assert.deepEqual(seen.args, ['-c', 'credential.interactive=false', 'credential', 'fill']);
  assert.equal(seen.opts.input, 'protocol=https\nhost=api.acme.test\nusername=api-key\n\n');
  assert.equal(seen.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(gitCredentialKey('h', 'u', { _spawnSync: () => ({ status: 128, stdout: '' }) }), null);
});

test('planted: no git is unsupported by name', () => {
  assert.throws(() => gitCredentialKey('h', 'u', { _spawnSync: () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }) }),
    (e) => e.kind === 'unsupported' && /git is not installed/.test(e.message));
});

test('planted: the ai-lab beside the recorded python is not the recorded version -> stale, naming setup', () => {
  refusedUnsupported(() => readCatalogue(fixture({ installed: '9.9.9' })),
    /ai-lab 9[.]9[.]9 beside .* is not the recorded 0[.]0[.]0-fixture.*node scripts[/]setup[/]setup[.]js/);
});

test('a cache missing a field setup always writes is refused by name', () => {
  refusedUnsupported(() => readCatalogue(fixture({ extra: { ai_lab_version: undefined } })), /is missing ai_lab_version/);
});

test('the fixture is the shape setup writes (ai-lab document, verbatim)', () => {
  const { cachePath } = providerCacheFixture();
  const doc = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.deepEqual(Object.keys(doc), CACHE_KEYS);
  for (const row of Object.values(doc.providers)) assert.deepEqual(Object.keys(row), ROW_KEYS);
  assert.deepEqual(Object.keys(doc.inputs[0]), ['path', 'exists', 'sha256']);
});
