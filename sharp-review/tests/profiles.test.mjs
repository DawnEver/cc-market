import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, resolveProfile, resolveWeights, pickProfileKey, globalWeightsForSources } from '../scripts/lib.mjs';

const close = (a, b) => Math.abs(a - b) < 1e-9;

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

test('PROFILES — source field on existing + new profiles', () => {
  assert.equal(PROFILES.diff.source, 'diff');
  assert.equal(PROFILES.architecture.source, 'codebase');

  // Three new profiles, in the default rotation with their own weights.
  const expectedWeights = { security: 0.05, docs: 0.1, deps: 0.05 };
  for (const key of ['security', 'docs', 'deps']) {
    assert.ok(PROFILES[key], `profile ${key} must exist`);
    assert.equal(PROFILES[key].weight, expectedWeights[key], `${key} default weight`);
    assert.ok(typeof PROFILES[key].framing === 'string' && PROFILES[key].framing.length);
    assert.ok(typeof PROFILES[key].reviewScope === 'string' && PROFILES[key].reviewScope.length);
  }
  // Default weights sum to 1.0.
  const total = Object.values(PROFILES).reduce((s, p) => s + p.weight, 0);
  assert.ok(Math.abs(total - 1.0) < 1e-9, `default weights sum to 1.0 (got ${total})`);
  assert.equal(PROFILES.security.source, 'diff');
  assert.equal(PROFILES.security.mode, null);          // honor manifest
  assert.equal(PROFILES.security.promptKind, 'diff');
  assert.equal(PROFILES.docs.source, 'docs');
  assert.equal(PROFILES.docs.mode, 'agent');
  assert.equal(PROFILES.docs.promptKind, 'architecture');
  assert.equal(PROFILES.deps.source, 'deps');
  assert.equal(PROFILES.deps.mode, 'agent');
});

test('all five profiles are in the default rotation', () => {
  const w = resolveWeights(null);
  assert.equal(w.diff, 0.6);
  assert.equal(w.architecture, 0.2);
  assert.equal(w.security, 0.05);
  assert.equal(w.docs, 0.1);
  assert.equal(w.deps, 0.05);
});

test('globalWeightsForSources — orphan mass folds into diff; specialists keep global weight', () => {
  // diff source fired → eligible {diff, security}; the .35 from arch/docs/deps folds into diff.
  const w = globalWeightsForSources(['diff'], null);
  assert.ok(close(w.diff, 0.95), `diff absorbs orphan mass (got ${w.diff})`);
  assert.ok(close(w.security, 0.05), 'security keeps its exact global weight');
  assert.equal(w.architecture, undefined);
  assert.equal(w.docs, undefined);

  // diff + docs fired → docs keeps .1, security .05, diff absorbs arch+deps (.25) → .85.
  const w2 = globalWeightsForSources(['diff', 'docs'], null);
  assert.ok(close(w2.diff, 0.85), `diff = .6 + orphan .25 (got ${w2.diff})`);
  assert.ok(close(w2.docs, 0.1), 'docs keeps its exact global weight');
  assert.ok(close(w2.security, 0.05), 'security keeps its exact global weight');

  // total mass is always conserved at 1.0 (weights sum to 1).
  const sum = Object.values(w2).reduce((s, x) => s + x, 0);
  assert.ok(close(sum, 1.0), `mass conserved (got ${sum})`);
});

test('globalWeightsForSources — diff ineligible: orphan spreads across eligible', () => {
  // doc-only change → only docs source fired; diff can't absorb, so docs takes all the mass.
  const w = globalWeightsForSources(['docs'], null);
  assert.ok(close(w.docs, 1.0), `docs absorbs everything when it is the sole eligible (got ${w.docs})`);
  assert.equal(w.diff, undefined);

  // codebase only → architecture takes the full mass.
  const cb = globalWeightsForSources(['codebase'], null);
  assert.ok(close(cb.architecture, 1.0), `architecture = full mass (got ${cb.architecture})`);
  assert.equal(cb.diff, undefined);
});

test('globalWeightsForSources — nothing eligible returns {} (caller skips)', () => {
  // docs source fired but docs weight overridden to 0 → no eligible profile.
  const w = globalWeightsForSources(['docs'], { docs: 0 });
  assert.deepEqual(w, {});
  // pickProfileKey degrades to diff on an empty map.
  assert.equal(pickProfileKey(w, 0.5), 'diff');
});

test('resolveProfile — known keys and fallback', () => {
  assert.equal(resolveProfile('diff').key, 'diff');
  assert.equal(resolveProfile('architecture').key, 'architecture');
  assert.equal(resolveProfile('nope').key, 'diff');     // unknown → diff
  assert.equal(resolveProfile(undefined).key, 'diff');
});

test('resolveWeights — defaults and per-project override', () => {
  const def = resolveWeights(null);
  assert.equal(def.diff, 0.6);
  assert.equal(def.architecture, 0.2);

  const over = resolveWeights({ diff: 0.5, architecture: 0.5 });
  assert.equal(over.diff, 0.5);
  assert.equal(over.architecture, 0.5);

  // Partial override keeps the un-overridden default.
  const partial = resolveWeights({ architecture: 0.4 });
  assert.equal(partial.diff, 0.6);
  assert.equal(partial.architecture, 0.4);

  // Garbage / non-positive weights are dropped, unknown keys ignored.
  const cleaned = resolveWeights({ architecture: 0, bogus: 1 });
  assert.equal(cleaned.architecture, undefined);
  assert.equal(cleaned.bogus, undefined);
  assert.equal(cleaned.diff, 0.6);
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

test('pickProfileKey — rand at/above 1.0 clamps into the last band', () => {
  const w = { diff: 0.8, architecture: 0.2 };
  // rand exactly 1.0 must NOT overflow past the last band (0.999999 clamp).
  assert.equal(pickProfileKey(w, 1.0), 'architecture');
  // just below 1.0 stays in-range too.
  assert.equal(pickProfileKey(w, 0.9999999), 'architecture');
});

test('pickProfileKey — negative weights are dropped before band selection', () => {
  // diff has negative weight → filtered out; architecture (only positive) wins.
  assert.equal(pickProfileKey({ diff: -1, architecture: 0.2 }, 0.5), 'architecture');
  assert.equal(pickProfileKey({ diff: -1, architecture: 0.2 }, 0.0), 'architecture');
});

test('resolveWeights — negative weight dropped, default kept for others', () => {
  const cleaned = resolveWeights({ diff: -1 });
  assert.equal(cleaned.diff, undefined);       // negative dropped
  assert.equal(cleaned.architecture, 0.2);     // default retained
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
