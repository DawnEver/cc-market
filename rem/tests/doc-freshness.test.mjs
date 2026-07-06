// doc-freshness.test.mjs — commit-anchored knowledge-base doc staleness
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  parseDocMeta,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  dayDrift,
  isDocStale,
  collectBoundDocs,
  commitDrift,
  lineDrift,
  loadAnchor,
  saveAnchor,
  evaluateDocs,
} from '../scripts/doc-freshness.js';

// ── parseDocMeta ──

test('parseDocMeta: extracts doc_source (semantic binding) from nested metadata', () => {
  const md = [
    '---',
    'name: setup-architecture',
    'description: how setup works',
    'metadata:',
    '  type: reference',
    '  doc_source: [scripts/setup/, claude_settings.template.json]',
    '---',
    '# body',
  ].join('\n');
  const meta = parseDocMeta(md);
  assert.deepEqual(meta.doc_source, ['scripts/setup/', 'claude_settings.template.json']);
  // Anchor fields are NOT in frontmatter — they live device-locally.
  assert.ok(!('git_hash' in meta));
  assert.ok(!('reviewed_at' in meta));
});

test('parseDocMeta: block-list doc_source form', () => {
  const md = [
    '---',
    'metadata:',
    '  doc_source:',
    '    - scripts/setup/',
    '    - README.md',
    '---',
  ].join('\n');
  const meta = parseDocMeta(md);
  assert.deepEqual(meta.doc_source, ['scripts/setup/', 'README.md']);
});

test('parseDocMeta: returns null when no doc_source (not a bound doc)', () => {
  const md = ['---', 'name: plain', 'metadata:', '  type: reference', '---', 'body'].join('\n');
  assert.equal(parseDocMeta(md), null);
});

test('parseDocMeta: returns null when no frontmatter', () => {
  assert.equal(parseDocMeta('just text'), null);
});

// ── thresholds ──

test('resolveThresholds: defaults when no override', () => {
  assert.deepEqual(resolveThresholds(), DEFAULT_THRESHOLDS);
  assert.deepEqual(resolveThresholds({}), DEFAULT_THRESHOLDS);
});

test('resolveThresholds: override wins per-field', () => {
  const r = resolveThresholds({ stale_commits: 10 });
  assert.equal(r.stale_commits, 10);
  assert.equal(r.stale_days, DEFAULT_THRESHOLDS.stale_days);
});

test('parseDocMeta: per-doc threshold override read from frontmatter', () => {
  const md = [
    '---', 'metadata:', '  doc_source: [src/]', '  git_hash: abc1234',
    '  stale_commits: 10', '  stale_days: 90', '---',
  ].join('\n');
  const meta = parseDocMeta(md);
  assert.equal(meta.stale_commits, 10);
  assert.equal(meta.stale_days, 90);
  assert.equal(resolveThresholds(meta).stale_commits, 10);
});

// ── dayDrift / isDocStale ──

test('dayDrift: whole-day delta', () => {
  assert.equal(dayDrift('2026-07-01', '2026-07-06'), 5);
  assert.equal(dayDrift(undefined, '2026-07-06'), Infinity);
});

test('isDocStale: stale if any of commits/days/lines exceeded', () => {
  const th = { stale_commits: 15, stale_days: 30, stale_lines: 200 };
  assert.equal(isDocStale({ commits: 16, days: 1, lines: 1 }, th), true);
  assert.equal(isDocStale({ commits: 1, days: 40, lines: 1 }, th), true);
  assert.equal(isDocStale({ commits: 1, days: 1, lines: 300 }, th), true); // churn trigger
  assert.equal(isDocStale({ commits: 1, days: 1, lines: 1 }, th), false);
  assert.equal(isDocStale({ commits: Infinity, days: 0, lines: 0 }, th), true);
});

// ── collectBoundDocs (git-discovered, gitignore-respecting) ──

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'docfresh-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  return { repo, git };
}

test('collectBoundDocs: finds only doc_source files, honors .gitignore', () => {
  const { repo, git } = initRepo();
  try {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    mkdirSync(join(repo, 'vendor'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'arch.md'), [
      '---', 'metadata:', '  doc_source: [src/]', '  git_hash: aaa1111', '---', 'x',
    ].join('\n'));
    writeFileSync(join(repo, 'docs', 'plain.md'), ['---', 'name: plain', '---', 'y'].join('\n'));
    writeFileSync(join(repo, 'vendor', 'bound.md'), ['---', 'metadata:', '  doc_source: [x/]', '---'].join('\n'));
    writeFileSync(join(repo, '.gitignore'), 'vendor/\n');
    git('add', '-A'); git('commit', '-qm', 'c0');

    const docs = collectBoundDocs(repo);
    assert.equal(docs.length, 1); // plain.md lacks doc_source; vendor/ is gitignored
    assert.equal(docs[0].relPath.replace(/\\/g, '/'), 'docs/arch.md');
    assert.deepEqual(docs[0].doc_source, ['src/']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('collectBoundDocs: empty when no bound docs (self-disabled)', () => {
  const { repo, git } = initRepo();
  try {
    writeFileSync(join(repo, 'README.md'), '# no frontmatter');
    git('add', '-A'); git('commit', '-qm', 'c0');
    assert.deepEqual(collectBoundDocs(repo), []);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── resolveDocRoots (discovery + device-local cache + ambiguity) ──

import { resolveDocRoots, docRootOf, saveDocRoots } from '../scripts/doc-freshness.js';
import { readFileSync as rf, existsSync as ex } from 'fs';

test('docRootOf: .claude/<sub> two-segment, else top segment', () => {
  assert.equal(docRootOf('docs/a/b.md'), 'docs');
  assert.equal(docRootOf('.claude/docs/x.md'), '.claude/docs');
});

test('resolveDocRoots: single root auto-persists to .rem-state.json cache', () => {
  const { repo, git } = initRepo();
  try {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'a.md'), ['---', 'metadata:', '  doc_source: [src/]', '---'].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'c0');
    const r = resolveDocRoots(repo);
    assert.deepEqual(r.roots, ['docs']);
    assert.ok(!r.ambiguous);
    const state = JSON.parse(rf(join(repo, '.claude', '.rem-state.json'), 'utf8'));
    assert.deepEqual(state.docs.roots, ['docs']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('resolveDocRoots: multiple roots → ambiguous, NOT persisted', () => {
  const { repo, git } = initRepo();
  try {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    mkdirSync(join(repo, '.claude', 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'a.md'), ['---', 'metadata:', '  doc_source: [src/]', '---'].join('\n'));
    writeFileSync(join(repo, '.claude', 'docs', 'b.md'), ['---', 'metadata:', '  doc_source: [lib/]', '---'].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'c0');
    const r = resolveDocRoots(repo);
    assert.ok(r.ambiguous);
    assert.deepEqual(r.roots, ['.claude/docs', 'docs']);
    assert.ok(!ex(join(repo, '.claude', '.rem-state.json')) ||
      !JSON.parse(rf(join(repo, '.claude', '.rem-state.json'), 'utf8')).docs?.roots);

    // User picks one → cached → resolveDocRoots returns it without re-discovering.
    saveDocRoots(repo, ['docs']);
    assert.deepEqual(resolveDocRoots(repo).roots, ['docs']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// ── commitDrift (real git) ──

test('commitDrift: counts commits touching doc_source paths since git_hash', () => {
  const repo = mkdtempSync(join(tmpdir(), 'docgit-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.js'), '1');
    writeFileSync(join(repo, 'other.js'), '1');
    git('add', '-A'); git('commit', '-qm', 'c0');
    const base = git('rev-parse', 'HEAD').trim();

    // one commit touching src/, one touching other.js only
    writeFileSync(join(repo, 'src', 'a.js'), '2');
    git('add', '-A'); git('commit', '-qm', 'c1');
    writeFileSync(join(repo, 'other.js'), '2');
    git('add', '-A'); git('commit', '-qm', 'c2');

    assert.equal(commitDrift(repo, base, ['src/']).commits, 1);
    assert.equal(commitDrift(repo, base, ['src/', 'other.js']).commits, 2);
    // churn: c1 changed src/a.js by 1 insertion + 1 deletion = 2 lines
    assert.equal(lineDrift(repo, base, ['src/']), 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commitDrift/lineDrift: missing git_hash → Infinity (unanchored)', () => {
  assert.equal(commitDrift(process.cwd(), undefined, ['src/']).commits, Infinity);
  assert.equal(lineDrift(process.cwd(), undefined, ['src/']), Infinity);
});

test('evaluateDocs: dangling doc_source (path gone) surfaces as stale, not silently fresh', () => {
  const { repo, git } = initRepo();
  try {
    mkdirSync(join(repo, '.claude', 'docs'), { recursive: true });
    // doc_source points at a path that does not exist → binding is broken.
    writeFileSync(join(repo, '.claude', 'docs', 'a.md'),
      ['---', 'metadata:', '  doc_source: [does/not/exist/]', '---'].join('\n'));
    git('add', '-A'); git('commit', '-qm', 'c0');
    saveAnchor(repo, '.claude/docs/a.md', { git_hash: git('rev-parse', '--short', 'HEAD').trim(), reviewed_at: '2026-07-06' });
    const stale = evaluateDocs(repo, repo, '2026-07-06'); // fresh anchor, but dangling
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0].dangling, ['does/not/exist/']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('loadAnchor/saveAnchor: device-local anchor round-trips via .rem-state.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docanchor-'));
  try {
    assert.deepEqual(loadAnchor(dir, 'docs/a.md'), {}); // none yet ⇒ unanchored
    saveAnchor(dir, 'docs/a.md', { git_hash: 'abc1234', reviewed_at: '2026-07-06' });
    assert.deepEqual(loadAnchor(dir, 'docs/a.md'), { git_hash: 'abc1234', reviewed_at: '2026-07-06' });
    // stored in the gitignored state file, not any tracked doc
    const state = JSON.parse(readFileSync(join(dir, '.claude', '.rem-state.json'), 'utf8'));
    assert.equal(state.docs.anchors['docs/a.md'].git_hash, 'abc1234');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
