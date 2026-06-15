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

test('default (weighted) run always emits a valid profile JSON', () => {
  const p = run([]);
  assert.ok(['diff', 'architecture'].includes(p.key));
  assert.ok('label' in p && 'mode' in p && 'promptKind' in p);
});

test('corrupt/missing state degrades gracefully (no throw, valid output)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', '.rem-state.json'), '{ not valid json', 'utf8');
    const p = run([], dir);
    assert.ok(['diff', 'architecture'].includes(p.key));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-project profileWeights forcing architecture is honored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-profile-'));
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    // Drive architecture to weight 1 (diff 0) so the weighted pick is deterministic.
    writeFileSync(
      join(dir, '.claude', '.rem-state.json'),
      JSON.stringify({ reviewGate: { profileWeights: { diff: 0, architecture: 1 } } }),
      'utf8',
    );
    // Run several times; with diff weight 0 it must always pick architecture.
    for (let i = 0; i < 8; i++) {
      assert.equal(run([], dir).key, 'architecture');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
