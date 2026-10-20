// The conformance fixtures under method/conformance/ are the single source every executor of the
// method is tested against (this Node executor here; the headless Python one in its own suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadMethod } from '../scripts/lib/method.mjs';

const method = loadMethod();
const ROOT = join(method.dir, method.files.conformance);
const KINDS = ['merge', 'pick', 'prompt'];

export function fixtures(kind) {
  return readdirSync(join(ROOT, kind)).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: `${kind}/${f}`, ...JSON.parse(readFileSync(join(ROOT, kind, f), 'utf8')) }));
}

test('conformance holds exactly the declared fixture kinds', () => {
  assert.deepEqual(readdirSync(ROOT).sort(), KINDS);
});

for (const kind of KINDS) {
  for (const fx of fixtures(kind)) {
    test(`fixture ${fx.file} has a description, an input and an expected result`, () => {
      assert.equal(typeof fx.description, 'string');
      assert.ok(fx.description.length > 0);
      assert.ok(fx.input !== undefined && fx.expected !== undefined);
    });
  }
}

// ── The Node executor against the fixtures ──
import { mergeRun } from '../scripts/lib/merge.mjs';
import { pickProfiles } from '../scripts/lib/pick.mjs';
import { renderTemplate, renderReviewerPrompt } from '../scripts/lib/prompt.mjs';

for (const fx of fixtures('merge')) {
  test(`node executor: ${fx.file}`, () => {
    assert.deepEqual(mergeRun(fx.input, method), fx.expected);
  });
}

for (const fx of fixtures('pick')) {
  test(`node executor: ${fx.file}`, () => {
    const { weights, count, rands } = fx.input;
    assert.deepEqual(pickProfiles(weights, count, rands, method), fx.expected);
  });
}

for (const fx of fixtures('prompt')) {
  test(`node executor: ${fx.file}`, () => {
    const { template, vars, profile, manifest } = fx.input;
    const actual = template !== undefined
      ? renderTemplate(template, vars, method)
      : renderReviewerPrompt(method.profiles[profile], manifest, method);
    assert.deepEqual(actual, fx.expected);
  });
}
