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

  it('has a schema version', () => {
    assert.equal(DEFAULT_STATE.version, 1);
  });

  it('has a hook key and no memory bookkeeping', () => {
    assert.ok('hook' in DEFAULT_STATE);
    assert.ok(!('prune' in DEFAULT_STATE));
  });

  it('hook has all required fields', () => {
    const keys = ['sessionKey', 'stopCount', 'firstStopAt', 'remPending', 'remDone', 'lastTouched', 'taskActiveUntil'];
    for (const k of keys) assert.ok(k in DEFAULT_STATE.hook, `missing: ${k}`);
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
  });

  it('deep-merges partial JSON with defaults', () => {
    const file = tmp('partial.json');
    writeFileSync(file, JSON.stringify({ hook: { stopCount: 5 } }));
    const state = loadState(file);
    assert.equal(state.hook.stopCount, 5);
    assert.equal(state.hook.sessionKey, null); // default
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
    saveState(file, { hook: { sessionKey: 'abc' } });
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.hook.sessionKey, 'abc');
    // loadState should deep-merge with defaults
    const state = loadState(file);
    assert.equal(state.hook.sessionKey, 'abc');
    assert.equal(state.hook.stopCount, 0); // default merged in
  });
});


// ── withStateLock ──

describe('withStateLock', async () => {
  const { withStateLock, loadState } = await import(stateUrl);

  it('loads fresh state inside the lock, mutates, and saves atomically', () => {
    const file = tmp('wsl.json');
    const res = withStateLock(file, (state) => {
      state.hook.stopCount = 7;
    });
    assert.equal(res.persisted, true);
    assert.equal(loadState(file).hook.stopCount, 7);
  });

  it('sees concurrent writes made before acquisition (no stale snapshot)', () => {
    const file = tmp('wsl-fresh.json');
    withStateLock(file, (s) => { s.hook.stopCount = 1; });
    // A second mutation must observe the first one's write
    withStateLock(file, (s) => { s.hook.stopCount = s.hook.stopCount + 1; });
    assert.equal(loadState(file).hook.stopCount, 2);
  });
});

// ── deepMerge edge cases ──

describe('deepMerge', async () => {
  const { loadState } = await import(stateUrl);

  it('preserves array from partial (replaces default)', () => {
    const file = tmp('arr.json');
    writeFileSync(file, JSON.stringify({ scopes: { ignore: ['a'] } }));
    assert.deepEqual(loadState(file).scopes.ignore, ['a']);
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
