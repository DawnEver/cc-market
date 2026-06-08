// shared/tests/state.test.mjs — tests for shared/state.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateUrl = pathToFileURL(join(__dirname, '..', 'state.mjs')).href;

let tmpDir;
function tmp(...parts) { return join(tmpDir, ...parts); }

before(() => {
  tmpDir = join(__dirname, '_tmp_state_test_' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ── DEFAULT_STATE ──

describe('DEFAULT_STATE', async () => {
  const { DEFAULT_STATE } = await import(stateUrl);

  it('has hook and prune keys', () => {
    assert.ok('hook' in DEFAULT_STATE);
    assert.ok('prune' in DEFAULT_STATE);
  });

  it('hook has all required fields', () => {
    const keys = ['sessionKey', 'stopCount', 'firstStopAt', 'remPending', 'remDone', 'lastTouched', 'taskActiveUntil'];
    for (const k of keys) assert.ok(k in DEFAULT_STATE.hook, `missing: ${k}`);
  });

  it('prune has all required fields', () => {
    assert.ok('lastPruneAt' in DEFAULT_STATE.prune);
    assert.ok('events' in DEFAULT_STATE.prune);
  });
});

// ── loadState ──

describe('loadState', async () => {
  const { loadState, DEFAULT_STATE } = await import(stateUrl);

  it('returns DEFAULT_STATE when file is missing', () => {
    const nonExistent = tmp('nonexistent.json');
    if (existsSync(nonExistent)) rmSync(nonExistent);
    const state = loadState(nonExistent);
    assert.deepEqual(state, DEFAULT_STATE);
  });

  it('loads and parses valid JSON', () => {
    const file = tmp('valid.json');
    writeFileSync(file, JSON.stringify({ hook: { sessionKey: 'test-session' } }));
    const state = loadState(file);
    assert.equal(state.hook.sessionKey, 'test-session');
    // Missing keys get defaults
    assert.equal(state.hook.stopCount, 0);
    assert.ok(Array.isArray(state.prune.events));
  });

  it('deep-merges partial JSON with defaults', () => {
    const file = tmp('partial.json');
    writeFileSync(file, JSON.stringify({ hook: { stopCount: 5 } }));
    const state = loadState(file);
    assert.equal(state.hook.stopCount, 5);
    assert.equal(state.hook.sessionKey, null); // default
    assert.equal(state.prune.lastPruneAt, 0);  // default
  });

  it('returns DEFAULT_STATE on parse error', () => {
    const file = tmp('invalid.json');
    writeFileSync(file, 'not valid json {{{');
    const state = loadState(file);
    assert.deepEqual(state, DEFAULT_STATE);
  });

  it('handles BOM-prefixed JSON', () => {
    const file = tmp('bom.json');
    writeFileSync(file, '﻿' + JSON.stringify({ hook: { stopCount: 3 } }));
    const state = loadState(file);
    assert.equal(state.hook.stopCount, 3);
  });
});

// ── saveState ──

describe('saveState', async () => {
  const { saveState, loadState, DEFAULT_STATE } = await import(stateUrl);

  it('creates file and parent directories', () => {
    const file = tmp('deep', 'nested', 'state.json');
    saveState(file, DEFAULT_STATE);
    assert.ok(existsSync(file));
  });

  it('writes properly formatted JSON', () => {
    const file = tmp('formatted.json');
    saveState(file, { hook: { sessionKey: 'abc' }, prune: { lastPruneAt: 123, events: [] } });
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.hook.sessionKey, 'abc');
    assert.equal(parsed.prune.lastPruneAt, 123);
    // loadState should deep-merge with defaults
    const state = loadState(file);
    assert.equal(state.hook.sessionKey, 'abc');
    assert.equal(state.hook.stopCount, 0); // default merged in
  });
});

// ── appendEvent ──

describe('appendEvent', async () => {
  const { appendEvent, loadState, DEFAULT_STATE } = await import(stateUrl);

  it('appends event with timestamp', () => {
    const file = tmp('events.json');
    // Start fresh
    writeFileSync(file, JSON.stringify(DEFAULT_STATE));
    appendEvent(file, 'test', { detail: 'my event' });

    const state = loadState(file);
    assert.equal(state.prune.events.length, 1);
    assert.equal(state.prune.events[0].type, 'test');
    assert.equal(state.prune.events[0].detail, 'my event');
    assert.ok(state.prune.events[0].ts);
  });

  it('trims events to 50', () => {
    const file = tmp('overflow.json');
    const state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    state.prune.events = Array.from({ length: 55 }, (_, i) => ({ ts: `ts${i}`, type: 'old' }));
    writeFileSync(file, JSON.stringify(state));

    appendEvent(file, 'new', {});
    const result = loadState(file);
    assert.equal(result.prune.events.length, 50);
    assert.equal(result.prune.events[49].type, 'new');
  });

  it('creates state from scratch if file is missing', () => {
    const file = tmp('scratch.json');
    if (existsSync(file)) rmSync(file);
    appendEvent(file, 'scratch', {});
    const state = loadState(file);
    assert.equal(state.prune.events.length, 1);
    assert.equal(state.prune.events[0].type, 'scratch');
  });
});

// ── deepMerge edge cases ──

describe('deepMerge', async () => {
  const { loadState } = await import(stateUrl);

  it('preserves array from partial (replaces default)', () => {
    const state = loadState('/nonexistent/path'); // empty → DEFAULT_STATE
    assert.ok(Array.isArray(state.prune.events));
    assert.equal(state.prune.events.length, 0);
  });

  it('handles non-object value for object-key in partial', () => {
    const file = tmp('nonObj.json');
    writeFileSync(file, JSON.stringify({ hook: 'not an object' }));
    const state = loadState(file);
    // hook should still be an object (default restored)
    assert.equal(typeof state.hook, 'object');
    assert.equal(state.hook.stopCount, 0);
  });
});
