// The method directory is the review METHOD as data; these tests pin its shape, not its prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMethod, METHOD_DIR, SUPPORTED_SCHEMA_VERSION } from '../scripts/lib/method.mjs';

test('the shipped method loads and declares the supported schema_version', () => {
  const m = loadMethod();
  assert.equal(m.schema_version, SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(m.profiles).sort(), ['adversarial', 'architecture', 'deps', 'diff', 'docs', 'security']);
});

test('every profile names a known context, a positive weight and a non-empty scope', () => {
  const m = loadMethod();
  for (const p of Object.values(m.profiles)) {
    assert.ok(p.context in m.contexts, `${p.key}: context ${p.context}`);
    assert.ok(p.weight > 0, `${p.key}: weight`);
    assert.ok(Array.isArray(p.scope) && p.scope.length > 0, `${p.key}: scope`);
    assert.ok(!('provider' in p), `${p.key} must not bind a provider`);
  }
});

test('every template a context or partial names exists in the method directory', () => {
  const m = loadMethod();
  const named = [
    ...Object.values(m.contexts).flatMap((c) => Object.values(c)).map((v) => v.template).filter(Boolean),
    ...Object.values(m.template.partials),
  ];
  for (const t of named) assert.ok(m.readTemplate(t).length > 0, t);
});

test('reviewer status vocabulary holds exactly the eight declared kinds', () => {
  const s = loadMethod().reviewer_status;
  assert.deepEqual(s.vocabulary, ['ok', 'exhausted', 'auth', 'rate_limit', 'timeout', 'unsupported', 'unavailable', 'skipped']);
  for (const k of [...s.failure_kinds, ...s.planned_final]) assert.ok(s.vocabulary.includes(k), k);
});

test('headless runs default to anthropic only and never synthesise', () => {
  const h = loadMethod().run_modes.headless;
  assert.deepEqual(h.providers, ['anthropic']);
  assert.equal(h.synthesis, false);
});

test('an unknown schema_version is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-method-'));
  cpSync(METHOD_DIR, dir, { recursive: true });
  const file = join(dir, 'method.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.schema_version = 99;
  writeFileSync(file, JSON.stringify(m));
  assert.throws(() => loadMethod(dir), /schema_version 99/);
});
