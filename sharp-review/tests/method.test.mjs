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

// ── The principle set (method/principles.json): one source, read by prompts, schema and merge ──

test('the principle set is data: unique kebab ids, each with a name and a statement', () => {
  const m = loadMethod();
  const ids = m.principleList.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of m.principleList) {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/, p.id);
    assert.ok(p.name && p.statement, p.id);
  }
  for (const id of ['first-principles', 'no-historical-baggage', 'occams-razor', 'single-source-of-truth',
    'layered-decoupling', 'names-match-behaviour', 'no-backward-compatibility', 'progressive-disclosure']) {
    assert.ok(ids.includes(id), id);
  }
});

test('the finding schema file names the field and never lists the ids; the loader fills them', () => {
  const m = loadMethod();
  const file = JSON.parse(readFileSync(join(METHOD_DIR, m.files.finding_schema), 'utf8'));
  assert.equal(file.properties[m.principles.finding_field].items.enum, undefined, 'a second copy of the ids');
  assert.deepEqual(m.findingSchema.properties[m.principles.finding_field].items.enum, m.principleList.map((p) => p.id));
});

test('a principle added to principles.json reaches the schema without another edit (planted control: absent before)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-method-'));
  cpSync(METHOD_DIR, dir, { recursive: true });
  const file = join(dir, 'principles.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!loadMethod(dir).findingSchema.properties.principles.items.enum.includes('fail-loud'));
  data.principles.push({ id: 'fail-loud', name: 'Fail loud', statement: 'An unsupported case raises.' });
  writeFileSync(file, JSON.stringify(data));
  assert.ok(loadMethod(dir).findingSchema.properties.principles.items.enum.includes('fail-loud'));
});

test('every reviewer template a context names renders the principles partial', () => {
  const m = loadMethod();
  const templates = Object.values(m.contexts).flatMap((c) => Object.values(c)).map((v) => v.template).filter(Boolean);
  assert.ok(templates.length >= 3);
  for (const t of templates) assert.match(m.readTemplate(t), /\{\{principles\}\}/, t);
});
