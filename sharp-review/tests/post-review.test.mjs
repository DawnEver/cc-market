// post-review.js end to end: a plan plus the reviewers' raw results -> the memory sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const POST_REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'post-review.js');

export function plan(over = {}) {
  return {
    schema_version: 1, run_id: 'run-1', started_at: '2026-06-21T10:00:00.000Z', date: '2026-06-21', range: 'HEAD', sink: 'memory',
    profiles: [{ key: 'diff', label: 'diff review' }, { key: 'adversarial', label: 'adversarial review' }],
    reviewers: [
      { name: 'diff', provider: 'codex', status: 'pending' },
      { name: 'adversarial', provider: 'deepseek', status: 'pending' },
    ],
    ...over,
  };
}

export function run(dir, planObj, raw, extra = []) {
  const planFile = join(dir, 'plan.json');
  const rawFile = join(dir, 'raw.json');
  writeFileSync(planFile, JSON.stringify(planObj));
  writeFileSync(rawFile, JSON.stringify(raw));
  return execFileSync('node', [POST_REVIEW, '--plan', planFile, '--raw', rawFile, ...extra], {
    cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8', stdio: 'pipe', windowsHide: true,
  });
}

const memFile = (dir) => join(dir, '.claude', 'memory', '2026', '06', '21', 'sharp-review.md');
const leak = { file: 'a.js', summary: 'leak', severity: 'HIGH', category: 'Bug' };

test('a successful gated review credits only its matching claim after writing the result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-complete-'));
  try {
    mkdirSync(join(dir, '.claude'));
    const stateFile = join(dir, '.claude', '.rem-state.json');
    writeFileSync(stateFile, JSON.stringify({ reviewGate: { pending: {
      token: 'claim', head: 'reviewed-head', stat: { lines: 400, files: 5 }, wave: 0,
      hashes: { diff: 'content' }, expiresAt: Date.now() + 60000,
    } }, hook: { sessions: { other: { remPending: true } } } }));
    run(dir, plan({ gate_token: 'claim' }), { run_id: 'run-1', results: [{ name: 'diff', findings: [] }] });
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.reviewGate.pending, null);
    assert.equal(state.reviewGate.reviewedHashes.diff, 'content');
    assert.equal(state.hook.sessions.other.remPending, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unavailable review releases the gate without recording a successful review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-unavailable-'));
  try {
    mkdirSync(join(dir, '.claude'));
    const stateFile = join(dir, '.claude', '.rem-state.json');
    writeFileSync(stateFile, JSON.stringify({ reviewGate: { pending: { token: 'claim', hashes: { diff: 'content' } } } }));
    run(dir, plan({ gate_token: 'claim' }), { run_id: 'run-1', results: [] });
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.reviewGate.pending, null);
    assert.equal(state.reviewGate.reviewedHashes, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stdout-only review output releases its gate without crediting persisted review content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-stdout-gate-'));
  try {
    mkdirSync(join(dir, '.claude'));
    const stateFile = join(dir, '.claude', '.rem-state.json');
    writeFileSync(stateFile, JSON.stringify({ reviewGate: { pending: {
      token: 'claim', hashes: { diff: 'content' }, expiresAt: Date.now() + 60000,
    } } }));
    const output = run(dir, plan({ gate_token: 'claim', sink: 'stdout' }), { run_id: 'run-1', results: [{ name: 'diff', findings: [] }] });
    assert.ok(JSON.parse(output).reviewers.some(reviewer => reviewer.status === 'ok'));
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.reviewGate.pending, null);
    assert.equal(state.reviewGate.reviewedHashes, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a persisted review survives gate-write failure without falsely acknowledging completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-gate-write-failure-'));
  try {
    mkdirSync(join(dir, '.claude'));
    const stateFile = join(dir, '.claude', '.rem-state.json');
    writeFileSync(stateFile, JSON.stringify({ reviewGate: { pending: {
      token: 'claim', hashes: { diff: 'content' }, expiresAt: Date.now() + 60000,
    } } }));
    mkdirSync(stateFile + '.tmp');
    assert.throws(() => run(dir, plan({ gate_token: 'claim' }),
      { run_id: 'run-1', results: [{ name: 'diff', findings: [] }] }), /persist.*gate/i);
    assert.match(readFileSync(memFile(dir), 'utf8'), /sharp-review/);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.reviewGate.pending.token, 'claim');
    assert.equal(state.reviewGate.reviewedHashes, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit cancellation releases only the named gate without a plan or paid reviewer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-release-'));
  try {
    mkdirSync(join(dir, '.claude'));
    const stateFile = join(dir, '.claude', '.rem-state.json');
    writeFileSync(stateFile, JSON.stringify({ reviewGate: { pending: { token: 'claim' } } }));
    const invoke = token => execFileSync(process.execPath, [POST_REVIEW, '--release-gate', token], {
      cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, windowsHide: true,
    });
    invoke('stale');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).reviewGate.pending.token, 'claim');
    invoke('claim');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).reviewGate.pending, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a two-reviewer agreement is written once, high-confidence, naming both reviewers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    const out = run(dir, plan(), { run_id: 'run-1', results: [
      { name: 'diff', findings: [leak] }, { name: 'adversarial', findings: [leak] },
    ] });
    const content = readFileSync(memFile(dir), 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /## Review 2026-06-21 \(session\) — diff review \+ adversarial review/);
    assert.match(content, /\[SR-20260621-001\] \[HIGH\] a\.js — leak/);
    assert.match(content, /\*\*Reviewers:\*\* diff \(codex\), adversarial \(deepseek\)/);
    assert.match(out, /Sharp review: 1 issues \(1 high-confidence\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reviewer with no result is unavailable and the run warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    run(dir, plan(), { run_id: 'run-1', results: [{ name: 'diff', findings: [leak] }] });
    const content = readFileSync(memFile(dir), 'utf8');
    assert.match(content, /- Reviewer adversarial \(deepseek\): unavailable/);
    assert.match(content, /Warning: only 1\/2 reviewers succeeded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a same-day second run appends as a follow-up with renumbered ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    run(dir, plan(), { run_id: 'run-1', results: [{ name: 'diff', findings: [leak] }, { name: 'adversarial', findings: [] }] });
    run(dir, plan({ run_id: 'run-2' }), { run_id: 'run-2', results: [{ name: 'diff', findings: [{ ...leak, summary: 'other' }] }, { name: 'adversarial', findings: [] }] });
    const content = readFileSync(memFile(dir), 'utf8');
    assert.match(content, /\(follow-up\)/);
    assert.match(content, /\[SR-20260621-002\] \[HIGH\] a\.js — other/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a raw file from another run is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    assert.throws(() => run(dir, plan(), { run_id: 'run-0', results: [] }), /raw\.json belongs to run run-0, not run run-1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a raw file older than the run is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    const future = new Date(Date.now() + 3600_000).toISOString();
    assert.throws(() => run(dir, plan({ started_at: future }), { run_id: 'run-1', results: [] }), /older than the run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--sink stdout prints the findings JSON and writes no memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    const out = run(dir, plan(), { run_id: 'run-1', results: [{ name: 'diff', findings: [leak] }, { name: 'adversarial', findings: [] }] }, ['--sink', 'stdout']);
    const json = JSON.parse(out);
    assert.equal(json.schema_version, 1);
    assert.deepEqual(json.profiles, ['diff', 'adversarial']);
    assert.deepEqual(json.reviewers.map((r) => [r.name, r.provider, r.status]), [['diff', 'codex', 'ok'], ['adversarial', 'deepseek', 'ok']]);
    assert.equal(json.findings[0].id, 'SR-20260621-001');
    assert.throws(() => readFileSync(memFile(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plan\'s own sink is the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    const out = run(dir, plan({ sink: 'stdout' }), { run_id: 'run-1', results: [] });
    assert.equal(JSON.parse(out).reviewers[0].status, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown sink is refused by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-post-'));
  try {
    assert.throws(() => run(dir, plan(), { run_id: 'run-1', results: [] }, ['--sink', 'gitea']), /unknown sink gitea/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
