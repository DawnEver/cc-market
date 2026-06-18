import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCES,
  evaluateSources,
  isLockfile,
  isDoc,
  DOCS_THRESHOLD_DEFAULT,
  CODEBASE_INTERVAL_MIN_DEFAULT,
} from '../sources.mjs';

// Minimal complete ctx with everything below threshold; tests override fields.
function ctx(over = {}) {
  return {
    changedFiles: [],
    diffStat: { lines: 0, files: 0 },
    waveThreshold: { lines: 300, files: 5 },
    minutesSinceLastReview: 0,
    docsThreshold: DOCS_THRESHOLD_DEFAULT,
    codebaseIntervalMin: CODEBASE_INTERVAL_MIN_DEFAULT,
    ...over,
  };
}

const src = (key) => SOURCES.find(s => s.key === key);

test('isLockfile — recognizes lockfiles, rejects others', () => {
  assert.equal(isLockfile('package-lock.json'), true);
  assert.equal(isLockfile('a/b/yarn.lock'), true);
  assert.equal(isLockfile('Cargo.lock'), true);
  assert.equal(isLockfile('go.sum'), true);
  assert.equal(isLockfile('src/index.js'), false);
  assert.equal(isLockfile('package.json'), false); // not a lockfile
});

test('isDoc — included: markup, named docs, docs/ trees', () => {
  // Named root docs (with/without extension, case-insensitive)
  assert.equal(isDoc('README.md'), true);
  assert.equal(isDoc('AGENTS.md'), true);
  assert.equal(isDoc('CHANGELOG'), true);
  assert.equal(isDoc('CONTRIBUTING.rst'), true);
  assert.equal(isDoc('SECURITY.md'), true);
  assert.equal(isDoc('changelog.MD'), true);
  // Markup extensions anywhere
  assert.equal(isDoc('foo.rst'), true);
  assert.equal(isDoc('notes/spec.mdx'), true);
  assert.equal(isDoc('a.adoc'), true);
  assert.equal(isDoc('plan.org'), true);
  // docs/ and doc/ trees at any depth
  assert.equal(isDoc('docs/guide.md'), true);
  assert.equal(isDoc('docs/guide.txt'), true);
  assert.equal(isDoc('a/docs/x.rst'), true);
  assert.equal(isDoc('doc/manual.html'), true);
});

test('isDoc — excluded: LICENSE, source, generated/built docs', () => {
  assert.equal(isDoc('LICENSE'), false);       // LICENSE is NOT a doc
  assert.equal(isDoc('LICENSE.md'), false);
  assert.equal(isDoc('src/app.ts'), false);
  // Generated/built documentation — exclusion wins over inclusion
  assert.equal(isDoc('docs/api/index.md'), false);
  assert.equal(isDoc('docs/_build/x.md'), false);
  assert.equal(isDoc('docs/html/index.html'), false);
  assert.equal(isDoc('site/index.md'), false);          // mkdocs default
  assert.equal(isDoc('_site/index.html'), false);       // jekyll
  assert.equal(isDoc('.docusaurus/x.md'), false);
  assert.equal(isDoc('target/doc/crate/index.html'), false); // rustdoc
  assert.equal(isDoc('a/javadoc/Foo.html'), false);
  assert.equal(isDoc('storybook-static/index.md'), false);
  assert.equal(isDoc('dist/readme.md'), false);         // LOW_VALUE generated
  assert.equal(isDoc('node_modules/pkg/README.md'), false);
  assert.equal(isDoc('foo.generated.md'), false);
});

test('diff source — fires at/above wave thresholds, mirrors hook gate', () => {
  const d = src('diff');
  assert.equal(d.triggerScore(ctx({ diffStat: { lines: 299, files: 4 } })).fired, false);
  assert.equal(d.triggerScore(ctx({ diffStat: { lines: 300, files: 0 } })).fired, true);
  assert.equal(d.triggerScore(ctx({ diffStat: { lines: 0, files: 5 } })).fired, true);
  // custom wave threshold respected
  assert.equal(d.triggerScore(ctx({ diffStat: { lines: 50, files: 0 }, waveThreshold: { lines: 40, files: 2 } })).fired, true);
});

test('codebase source — fires when interval elapsed', () => {
  const c = src('codebase');
  assert.equal(c.triggerScore(ctx({ minutesSinceLastReview: CODEBASE_INTERVAL_MIN_DEFAULT - 1 })).fired, false);
  assert.equal(c.triggerScore(ctx({ minutesSinceLastReview: CODEBASE_INTERVAL_MIN_DEFAULT })).fired, true);
  assert.equal(c.triggerScore(ctx({ minutesSinceLastReview: 5, codebaseIntervalMin: 5 })).fired, true);
});

test('deps source — fires on lockfile change', () => {
  const d = src('deps');
  assert.equal(d.triggerScore(ctx({ changedFiles: ['src/a.js'] })).fired, false);
  assert.equal(d.triggerScore(ctx({ changedFiles: ['src/a.js', 'pnpm-lock.yaml'] })).fired, true);
});

test('docs source — fires at/above docsThreshold doc files', () => {
  const d = src('docs');
  assert.equal(d.triggerScore(ctx({ changedFiles: ['a.md', 'b.md'] })).fired, false); // 2 < 3
  assert.equal(d.triggerScore(ctx({ changedFiles: ['a.md', 'b.md', 'docs/c.txt'] })).fired, true);
  assert.equal(d.triggerScore(ctx({ changedFiles: ['a.md'], docsThreshold: 1 })).fired, true);
});

test('triggerScore — pure shape with score/threshold/reason', () => {
  const r = src('diff').triggerScore(ctx({ diffStat: { lines: 400, files: 1 } }));
  assert.equal(r.fired, true);
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.threshold, 'number');
  assert.ok(typeof r.reason === 'string' && r.reason.length);
});

test('evaluateSources — aggregates fired keys + reasons', () => {
  const out = evaluateSources(ctx({
    diffStat: { lines: 500, files: 1 },
    changedFiles: ['yarn.lock', 'a.md', 'b.md', 'c.md'],
  }));
  assert.ok(out.fired.includes('diff'));
  assert.ok(out.fired.includes('deps'));
  assert.ok(out.fired.includes('docs'));
  assert.ok(!out.fired.includes('codebase'));
  assert.ok(out.reasons.diff && out.reasons.deps && out.reasons.docs);
});

test('evaluateSources — none fired yields empty list', () => {
  const out = evaluateSources(ctx());
  assert.deepEqual(out.fired, []);
});
