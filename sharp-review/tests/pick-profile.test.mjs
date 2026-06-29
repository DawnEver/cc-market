import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scripts', 'pick-profile.js');

function run(args, projectDir) {
  const out = execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir || HERE },
  });
  return JSON.parse(out); // array of profile objects
}

test('--profile forces a specific profile (single-element array)', () => {
  const arch = run(['--profile', 'architecture']);
  assert.ok(Array.isArray(arch) && arch.length === 1, 'forced profile returns single-element array');
  assert.equal(arch[0].key, 'architecture');
  assert.equal(arch[0].mode, 'agent');
  assert.equal(arch[0].promptKind, 'architecture');

  const diff = run(['--profile', 'diff']);
  assert.equal(diff[0].key, 'diff');
});

test('--profile with unknown key falls back to diff', () => {
  assert.equal(run(['--profile', 'nope'])[0].key, 'diff');
});

test('output is always a non-empty array of profile objects', () => {
  const p = run([]);
  assert.ok(Array.isArray(p) && p.length >= 1, `is an array with ${p.length} items`);
  for (const prof of p) {
    assert.ok('key' in prof && 'label' in prof && 'mode' in prof && 'promptKind' in prof);
  }
  // Manual run (no --sources) with all profiles eligible → usually picks 2.
  // Statistically overwhelming chance of picking 2 from 6 profiles.
});

test('corrupt/missing config degrades gracefully (no throw, valid output)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'sharp-review.json'), '{ not valid json', 'utf8');
    const p = run([], dir);
    assert.ok(Array.isArray(p) && p.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--sources constrains selection to that source set', () => {
  // Only the codebase source → architecture is the sole eligible profile → single element.
  for (let i = 0; i < 8; i++) {
    const p = run(['--sources', 'codebase']);
    assert.equal(p.length, 1, 'only architecture eligible');
    assert.equal(p[0].key, 'architecture');
  }
  // Diff source → eligible are diff + security + adversarial (3 profiles) → picks 2.
  const diffKeys = ['diff', 'security', 'adversarial'];
  for (let i = 0; i < 8; i++) {
    const p = run(['--sources', 'diff']);
    assert.ok(p.length === 2, `picks 2 from diff-eligible (got ${p.length})`);
    for (const prof of p) {
      assert.ok(diffKeys.includes(prof.key), `${prof.key} is diff-sourced`);
    }
    assert.notEqual(p[0].key, p[1].key, 'no duplicate picks');
  }
});

function writeConfig(dir, config) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'sharp-review.json'), JSON.stringify(config), 'utf8');
}

test('--sources docs with per-project weight selects docs profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    writeConfig(dir, { profileWeights: { docs: 1 } });
    for (let i = 0; i < 8; i++) {
      const p = run(['--sources', 'docs'], dir);
      assert.equal(p.length, 1, 'only docs eligible');
      assert.equal(p[0].key, 'docs');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom profile from config participates in selection and is resolvable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    writeConfig(dir, {
      profileWeights: { architecture: 0 },
      customProfiles: [{
        key: 'arch-hygiene', source: 'codebase', weight: 1, label: '整洁锐评',
        framing: 'hygiene pass', reviewScope: ['boundaries', 'duplication'],
      }],
    });
    // Only arch-hygiene eligible (architecture weight=0) → single element.
    for (let i = 0; i < 8; i++) {
      const p = run(['--sources', 'codebase'], dir);
      assert.equal(p.length, 1);
      assert.equal(p[0].key, 'arch-hygiene');
      assert.equal(p[0].mode, 'agent');
      assert.equal(p[0].promptKind, 'architecture');
      assert.equal(p[0].framing, 'hygiene pass');
      assert.equal(p[0].reviewScope, 'boundaries, duplication');
    }
    assert.equal(run(['--profile', 'arch-hygiene'], dir)[0].key, 'arch-hygiene');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no --sources flag uses the full default rotation', () => {
  for (let i = 0; i < 12; i++) {
    const p = run([]);
    assert.ok(Array.isArray(p) && p.length >= 1);
    // At least one profile should be one of the known keys.
    const keys = p.map(x => x.key);
    assert.ok(keys.some(k => ['diff', 'architecture', 'security', 'docs', 'deps', 'adversarial'].includes(k)));
    if (p.length >= 2) assert.notEqual(p[0].key, p[1].key, 'no duplicate');
  }
});

test('--profile override still works with --sources present', () => {
  const p = run(['--sources', 'codebase', '--profile', 'docs']);
  assert.equal(p.length, 1);
  assert.equal(p[0].key, 'docs');
});

test('per-project profileWeights forcing architecture is honored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    writeConfig(dir, { profileWeights: { diff: 0, architecture: 1, security: 0, docs: 0, deps: 0, adversarial: 0 } });
    // Only architecture has weight > 0 → single element.
    for (let i = 0; i < 8; i++) {
      const p = run([], dir);
      assert.equal(p.length, 1);
      assert.equal(p[0].key, 'architecture');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
