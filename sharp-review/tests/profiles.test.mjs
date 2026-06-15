import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, resolveProfile, resolveWeights, pickProfileKey } from '../lib.mjs';

test('PROFILES — diff and architecture shapes', () => {
  assert.equal(PROFILES.diff.key, 'diff');
  assert.equal(PROFILES.diff.mode, null);            // honors diff-manifest
  assert.equal(PROFILES.diff.promptKind, 'diff');
  assert.equal(PROFILES.diff.framing, null);
  assert.equal(PROFILES.diff.reviewScope, null);

  assert.equal(PROFILES.architecture.key, 'architecture');
  assert.equal(PROFILES.architecture.mode, 'agent');  // forced
  assert.equal(PROFILES.architecture.promptKind, 'architecture');
  assert.ok(typeof PROFILES.architecture.framing === 'string' && PROFILES.architecture.framing.length);
  assert.ok(typeof PROFILES.architecture.reviewScope === 'string' && PROFILES.architecture.reviewScope.length);

  // Profiles never bind a provider, and never override the SR id prefix.
  for (const p of Object.values(PROFILES)) {
    assert.ok(!('provider' in p), `${p.key} must not bind a provider`);
    assert.ok(!('idPrefix' in p), `${p.key} must not override idPrefix (stays SR)`);
  }
});

test('resolveProfile — known keys and fallback', () => {
  assert.equal(resolveProfile('diff').key, 'diff');
  assert.equal(resolveProfile('architecture').key, 'architecture');
  assert.equal(resolveProfile('nope').key, 'diff');     // unknown → diff
  assert.equal(resolveProfile(undefined).key, 'diff');
});

test('resolveWeights — defaults and per-project override', () => {
  const def = resolveWeights(null);
  assert.equal(def.diff, 0.8);
  assert.equal(def.architecture, 0.2);

  const over = resolveWeights({ diff: 0.5, architecture: 0.5 });
  assert.equal(over.diff, 0.5);
  assert.equal(over.architecture, 0.5);

  // Partial override keeps the un-overridden default.
  const partial = resolveWeights({ architecture: 0.4 });
  assert.equal(partial.diff, 0.8);
  assert.equal(partial.architecture, 0.4);

  // Garbage / non-positive weights are dropped, unknown keys ignored.
  const cleaned = resolveWeights({ architecture: 0, bogus: 1 });
  assert.equal(cleaned.architecture, undefined);
  assert.equal(cleaned.bogus, undefined);
  assert.equal(cleaned.diff, 0.8);
});

test('pickProfileKey — deterministic cumulative bands', () => {
  const w = { diff: 0.8, architecture: 0.2 };
  // total=1.0; diff band [0,0.8), architecture band [0.8,1.0)
  assert.equal(pickProfileKey(w, 0.0), 'diff');
  assert.equal(pickProfileKey(w, 0.5), 'diff');
  assert.equal(pickProfileKey(w, 0.79), 'diff');
  assert.equal(pickProfileKey(w, 0.8), 'architecture');
  assert.equal(pickProfileKey(w, 0.99), 'architecture');
});

test('pickProfileKey — single profile always wins', () => {
  assert.equal(pickProfileKey({ architecture: 0.2 }, 0.0), 'architecture');
  assert.equal(pickProfileKey({ architecture: 0.2 }, 0.999), 'architecture');
});

test('pickProfileKey — empty/garbage weights degrade to diff', () => {
  assert.equal(pickProfileKey({}, 0.5), 'diff');
  assert.equal(pickProfileKey({ diff: 0, architecture: 0 }, 0.5), 'diff');
});

test('pickProfileKey — non-finite rand treated as 0', () => {
  assert.equal(pickProfileKey({ diff: 0.8, architecture: 0.2 }, NaN), 'diff');
});
