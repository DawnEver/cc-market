import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, resolveProfile, resolveWeights, pickProfileKey, eligibleWeights, pickNProfileKeys, normalizeCustomProfile, mergeProfiles } from '../scripts/lib.mjs';

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

  // Specialist profiles in the default rotation with their own weights.
  const expectedWeights = { security: 0.05, docs: 0.1, deps: 0.05, adversarial: 0.1 };
  for (const key of ['security', 'docs', 'deps', 'adversarial']) {
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
  assert.equal(PROFILES.adversarial.source, 'diff');
  assert.equal(PROFILES.adversarial.mode, null);          // honor manifest
  assert.equal(PROFILES.adversarial.promptKind, 'diff');
});

test('all six profiles are in the default rotation', () => {
  const w = resolveWeights(null);
  assert.equal(w.diff, 0.5);
  assert.equal(w.architecture, 0.2);
  assert.equal(w.security, 0.05);
  assert.equal(w.adversarial, 0.1);
  assert.equal(w.docs, 0.1);
  assert.equal(w.deps, 0.05);
});

test('eligibleWeights — filters by source, no orphan mass', () => {
  // diff source fired → eligible {diff, security, adversarial} with their exact global weights.
  const w = eligibleWeights(['diff'], null);
  assert.ok(close(w.diff, 0.5), `diff keeps its own weight (got ${w.diff})`);
  assert.ok(close(w.security, 0.05), 'security keeps its exact global weight');
  assert.ok(close(w.adversarial, 0.1), 'adversarial keeps its exact global weight');
  assert.equal(w.architecture, undefined);
  assert.equal(w.docs, undefined);
  assert.equal(w.deps, undefined);

  // diff + docs fired → diff, security, adversarial, docs all eligible at their own weights.
  const w2 = eligibleWeights(['diff', 'docs'], null);
  assert.ok(close(w2.diff, 0.5));
  assert.ok(close(w2.docs, 0.1));
  assert.ok(close(w2.security, 0.05));
  assert.ok(close(w2.adversarial, 0.1));
  assert.equal(w2.architecture, undefined);

  // codebase only → only architecture eligible.
  const cb = eligibleWeights(['codebase'], null);
  assert.ok(close(cb.architecture, 0.2));
  assert.equal(cb.diff, undefined);

  // docs only → only docs eligible with its own weight.
  const d = eligibleWeights(['docs'], null);
  assert.ok(close(d.docs, 0.1));
  assert.equal(d.diff, undefined);

  // No sources → all weights returned (manual run).
  const all = eligibleWeights(null, null);
  assert.ok(Object.keys(all).length >= 6);
});

test('eligibleWeights — nothing eligible returns {} (caller skips)', () => {
  const w = eligibleWeights(['docs'], { docs: 0 });
  assert.deepEqual(w, {});
  assert.equal(pickProfileKey(w, 0.5), 'diff');
});

test('pickNProfileKeys — weighted random without replacement', () => {
  const w = { diff: 0.5, security: 0.05, adversarial: 0.1 };

  // rands=[0.0, 0.0] → both picks land on diff first, then security (diff removed after 1st pick).
  const r1 = pickNProfileKeys(w, 2, [0.0, 0.0]);
  // pick 1: rand=0, threshold 0 → diff (band [0, 0.5))
  // pick 2: remaining {security:0.05, adversarial:0.1}, total=0.15, rand=0 → security (band [0, 0.05))
  assert.deepEqual(r1, ['diff', 'security']);

  // rands=[0.999, 0.0] → 1st pick: adversarial (last band), 2nd from remaining.
  const r2 = pickNProfileKeys(w, 2, [0.999, 0.999]);
  assert.ok(r2.includes('adversarial'));
  assert.equal(r2.length, 2);
  assert.notEqual(r2[0], r2[1]);

  // Single entry → returns just 1.
  assert.deepEqual(pickNProfileKeys({ architecture: 0.2 }, 2, [0.5, 0.5]), ['architecture']);

  // Empty weights → fallback to ['diff'].
  assert.deepEqual(pickNProfileKeys({}, 2, [0.5, 0.5]), ['diff']);

  // n=0 → empty result.
  assert.deepEqual(pickNProfileKeys(w, 0), []);
});

test('resolveProfile — known keys and fallback', () => {
  assert.equal(resolveProfile('diff').key, 'diff');
  assert.equal(resolveProfile('architecture').key, 'architecture');
  assert.equal(resolveProfile('nope').key, 'diff');     // unknown → diff
  assert.equal(resolveProfile(undefined).key, 'diff');
});

test('resolveWeights — defaults and per-project override', () => {
  const def = resolveWeights(null);
  assert.equal(def.diff, 0.5);
  assert.equal(def.architecture, 0.2);

  const over = resolveWeights({ diff: 0.5, architecture: 0.5 });
  assert.equal(over.diff, 0.5);
  assert.equal(over.architecture, 0.5);

  // Partial override keeps the un-overridden default.
  const partial = resolveWeights({ architecture: 0.4 });
  assert.equal(partial.diff, 0.5);
  assert.equal(partial.architecture, 0.4);

  // Garbage / non-positive weights are dropped, unknown keys ignored.
  const cleaned = resolveWeights({ architecture: 0, bogus: 1 });
  assert.equal(cleaned.architecture, undefined);
  assert.equal(cleaned.bogus, undefined);
  assert.equal(cleaned.diff, 0.5);
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

// ── Custom (config-driven) profiles ──

test('normalizeCustomProfile — fills defaults; requires key + source', () => {
  assert.equal(normalizeCustomProfile(null), null);
  assert.equal(normalizeCustomProfile({ key: 'x' }), null);          // no source
  assert.equal(normalizeCustomProfile({ source: 'codebase' }), null); // no key

  const p = normalizeCustomProfile({ key: 'arch-hygiene', source: 'codebase' });
  assert.equal(p.key, 'arch-hygiene');
  assert.equal(p.label, 'arch-hygiene');     // defaults to key
  assert.equal(p.source, 'codebase');
  assert.equal(p.weight, 0.1);               // default
  assert.equal(p.mode, 'agent');             // default
  assert.equal(p.promptKind, 'architecture');// default
  assert.equal(p.framing, null);
  assert.equal(p.reviewScope, null);
  assert.equal(p.custom, true);
});

test('normalizeCustomProfile — normalizes scope array, mode, weight', () => {
  const p = normalizeCustomProfile({
    key: 'k', source: 'codebase', label: 'L', weight: 0.3, mode: 'review',
    promptKind: 'diff', framing: ' f ', reviewScope: ['a', '', 'b'],
  });
  assert.equal(p.label, 'L');
  assert.equal(p.weight, 0.3);
  assert.equal(p.mode, 'review');
  assert.equal(p.promptKind, 'diff');
  assert.equal(p.framing, 'f');              // trimmed
  assert.equal(p.reviewScope, 'a, b');       // array joined, empties dropped

  // mode null (honor diff-manifest) is preserved; garbage mode → 'agent'
  assert.equal(normalizeCustomProfile({ key: 'k', source: 'diff', mode: null }).mode, null);
  assert.equal(normalizeCustomProfile({ key: 'k', source: 'diff', mode: 'bogus' }).mode, 'agent');
  // non-positive weight → default 0.1
  assert.equal(normalizeCustomProfile({ key: 'k', source: 'diff', weight: 0 }).weight, 0.1);
});

test('mergeProfiles — adds custom, skips invalid, custom can override built-in', () => {
  assert.equal(mergeProfiles(null), PROFILES);         // no custom → identity
  assert.equal(mergeProfiles([]), PROFILES);

  const reg = mergeProfiles([
    { key: 'arch-hygiene', source: 'codebase', weight: 0.5, reviewScope: ['boundaries'] },
    { bogus: true },                                   // invalid → skipped
  ]);
  assert.ok(reg !== PROFILES, 'returns a new registry');
  assert.equal(reg['arch-hygiene'].weight, 0.5);
  assert.equal(reg['arch-hygiene'].source, 'codebase');
  assert.ok(reg.diff, 'built-ins preserved');

  // override a built-in key
  const reg2 = mergeProfiles([{ key: 'diff', source: 'diff', weight: 0.9 }]);
  assert.equal(reg2.diff.weight, 0.9);
  assert.equal(reg2.diff.custom, true);
});

test('custom profile participates in source-gated selection', () => {
  const reg = mergeProfiles([{ key: 'arch-hygiene', source: 'codebase', weight: 0.5 }]);
  // codebase fired → eligible {architecture(.2), arch-hygiene(.5)}.
  const w = eligibleWeights(['codebase'], null, reg);
  assert.ok(w['arch-hygiene'] > 0, 'custom profile is eligible when its source fires');
  assert.ok(w.architecture > 0, 'built-in also eligible');
  assert.ok(close(w.architecture, 0.2), 'architecture keeps its own weight');
  assert.ok(close(w['arch-hygiene'], 0.5), 'arch-hygiene keeps its own weight');
  // Each profile stands on its own — no mass transfer.
  assert.equal(w.diff, undefined, 'cold sources are absent, not folded');
  // resolveProfile finds it via the same registry
  assert.equal(resolveProfile('arch-hygiene', reg).key, 'arch-hygiene');

  // pickNProfileKeys works with the custom registry.
  const keys = pickNProfileKeys(w, 2, [0.0, 0.999]);
  assert.ok(keys.includes('arch-hygiene') || keys.includes('architecture'));
  assert.equal(keys.length, 2);
});
