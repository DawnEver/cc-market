// buildPlan: method data + project config + manifest -> reviewers with providers and prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadMethod } from '../scripts/lib/method.mjs';
import { buildPlan } from '../scripts/lib/plan.mjs';
import { effectiveProfiles, eligibleWeights } from '../scripts/lib/pick.mjs';

const method = loadMethod();
const manifest = { mode: 'review', range: 'HEAD', stats: {}, excludedSummary: '', diff: '+x' };
const base = { method, manifest, rands: { pick: [0, 0], shuffle: [0, 0] }, runId: 'r', startedAt: 't', date: '2026-10-20', seed: 0 };

test('interactive: two profiles over the alphabetical roster rotated by seed', () => {
  const p = buildPlan({ ...base, sources: ['diff'], available: ['kimi', 'claude', 'codex'], seed: 1 });
  assert.equal(p.reviewers.length, 2);
  assert.deepEqual(p.reviewers.map((r) => r.provider).sort(), ['codex', 'kimi']);
  for (const r of p.reviewers) {
    assert.equal(r.status, 'pending');
    assert.equal(r.call_mode, 'review');
    assert.match(r.prompt, /\+x/);
  }
});

test('interactive: claude reviewers carry the model the method declares', () => {
  const p = buildPlan({ ...base, forced: 'diff', available: ['claude'] });
  assert.equal(p.reviewers[0].model, 'opus');
});

test('a diff profile on an empty manifest is skipped; an explore profile still runs', () => {
  const empty = { ...manifest, mode: 'empty', diff: undefined };
  const p = buildPlan({ ...base, manifest: empty, sources: ['diff', 'deps'], available: ['claude', 'codex'], rands: { pick: [0, 0.99], shuffle: [0, 0] } });
  const byName = Object.fromEntries(p.reviewers.map((r) => [r.name, r]));
  assert.equal(byName.diff.status, 'skipped');
  assert.equal(byName.deps.status, 'pending');
  assert.equal(byName.deps.call_mode, 'agent');
});

test('a forced unknown profile is refused by name', () => {
  assert.throws(() => buildPlan({ ...base, forced: 'nope', available: ['claude'] }), /unknown profile nope/);
});

test('custom profiles add to the method set and weights retune it', () => {
  const profiles = effectiveProfiles(method, {
    customProfiles: [{ key: 'hygiene', source: 'codebase', context: 'explore', scope: ['dead code'], weight: 0.3 }],
    profileWeights: { architecture: 0 },
  });
  assert.equal(profiles.hygiene.label, 'hygiene');
  assert.deepEqual(eligibleWeights(profiles, { sources: ['codebase'] }), [['architecture', 0], ['hygiene', 0.3]]);
});

test('an invalid custom profile is refused by name, not skipped', () => {
  assert.throws(() => effectiveProfiles(method, { customProfiles: [{ key: 'x', source: 'diff' }] }), /x.*lacks context, scope/);
});
