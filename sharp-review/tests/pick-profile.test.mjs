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
  return JSON.parse(out);
}

test('--profile forces a specific profile regardless of weights', () => {
  const arch = run(['--profile', 'architecture']);
  assert.equal(arch.key, 'architecture');
  assert.equal(arch.mode, 'agent');
  assert.equal(arch.promptKind, 'architecture');

  const diff = run(['--profile', 'diff']);
  assert.equal(diff.key, 'diff');
});

test('--profile with unknown key falls back to diff', () => {
  assert.equal(run(['--profile', 'nope']).key, 'diff');
});

const ALL_KEYS = ['diff', 'architecture', 'security', 'docs', 'deps'];

test('default (weighted) run always emits a valid profile JSON', () => {
  const p = run([]);
  assert.ok(ALL_KEYS.includes(p.key));
  assert.ok('label' in p && 'mode' in p && 'promptKind' in p);
});

test('corrupt/missing config degrades gracefully (no throw, valid output)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'sharp-review.json'), '{ not valid json', 'utf8');
    const p = run([], dir);
    assert.ok(ALL_KEYS.includes(p.key));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--sources constrains selection to that source set', () => {
  // Only the codebase source → architecture is the sole eligible profile.
  for (let i = 0; i < 8; i++) {
    assert.equal(run(['--sources', 'codebase']).key, 'architecture');
  }
  // Only the diff source → eligible profiles are diff + security (both source 'diff').
  for (let i = 0; i < 8; i++) {
    assert.ok(['diff', 'security'].includes(run(['--sources', 'diff']).key));
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
      assert.equal(run(['--sources', 'docs'], dir).key, 'docs');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom profile from config participates in selection and is resolvable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    writeConfig(dir, {
      // zero the built-in codebase profile so the only eligible codebase profile is the custom one
      profileWeights: { architecture: 0 },
      customProfiles: [{
        key: 'arch-hygiene', source: 'codebase', weight: 1, label: '整洁锐评',
        framing: 'hygiene pass', reviewScope: ['boundaries', 'duplication'],
      }],
    });
    for (let i = 0; i < 8; i++) {
      const p = run(['--sources', 'codebase'], dir);
      assert.equal(p.key, 'arch-hygiene');
      assert.equal(p.mode, 'agent');             // default for custom
      assert.equal(p.promptKind, 'architecture');
      assert.equal(p.framing, 'hygiene pass');
      assert.equal(p.reviewScope, 'boundaries, duplication');
    }
    // forced selection of a custom key also works
    assert.equal(run(['--profile', 'arch-hygiene'], dir).key, 'arch-hygiene');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no --sources flag uses the full default rotation', () => {
  for (let i = 0; i < 12; i++) {
    assert.ok(ALL_KEYS.includes(run([]).key));
  }
});

test('--profile override still works with --sources present', () => {
  assert.equal(run(['--sources', 'codebase', '--profile', 'docs']).key, 'docs');
});

test('per-project profileWeights forcing architecture is honored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    // Zero out every other profile so the weighted pick is deterministically architecture.
    writeConfig(dir, { profileWeights: { diff: 0, architecture: 1, security: 0, docs: 0, deps: 0 } });
    // Run several times; with all others at weight 0 it must always pick architecture.
    for (let i = 0; i < 8; i++) {
      assert.equal(run([], dir).key, 'architecture');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
