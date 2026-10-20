// method/findings-output.schema.json is the versioned contract a findings-JSON reader relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadMethod } from '../scripts/lib/method.mjs';

const method = loadMethod();
const schema = JSON.parse(readFileSync(join(method.dir, method.files.output_schema), 'utf8'));

// Enough JSON Schema to check the contract: type, const, enum, pattern, required, properties,
// additionalProperties false, items.
function errors(value, s, at = '$') {
  const out = [];
  const types = s.type ? [].concat(s.type) : null;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types && !types.includes(typeOf(value)) && !(types.includes('number') && typeof value === 'number')) out.push(`${at}: type ${typeOf(value)}`);
  if ('const' in s && value !== s.const) out.push(`${at}: not ${s.const}`);
  if (s.enum && !s.enum.includes(value)) out.push(`${at}: ${value} not in enum`);
  if (s.pattern && !new RegExp(s.pattern).test(value)) out.push(`${at}: ${value} !~ ${s.pattern}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of s.required || []) if (!(k in value)) out.push(`${at}.${k}: missing`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties?.[k]) out.push(...errors(v, s.properties[k], `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}.${k}: not allowed`);
    }
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => out.push(...errors(v, s.items, `${at}[${i}]`)));
  return out;
}

test('every merge fixture result satisfies the output schema', () => {
  const dir = join(method.dir, method.files.conformance, 'merge');
  for (const f of readdirSync(dir)) {
    const { expected } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.deepEqual(errors(expected, schema), [], f);
  }
});

test('the schema version and enums are the method\'s own, not a second copy that can drift', () => {
  assert.equal(schema.properties.schema_version.const, method.schema_version);
  assert.deepEqual(schema.properties.reviewers.items.properties.status.enum, method.reviewer_status.vocabulary);
  const finding = schema.properties.findings.items.properties;
  assert.deepEqual(finding.severity.enum, method.findingSchema.properties.severity.enum);
  assert.deepEqual(finding.category.enum, method.findingSchema.properties.category.enum);
  assert.equal(finding.status.const, method.merge.defaults.status);
});

test('a planted violation is caught (the checker is not vacuous)', () => {
  assert.notDeepEqual(errors({ schema_version: 1, range: 'HEAD', profiles: [], reviewers: [{ name: 'a', provider: 'x', status: 'failed', dropped_findings: 0 }], findings: [] }, schema), []);
});
