// lib/ai-lab.mjs: the planner and the merge are ai-lab's; an absent ai-lab is AiLabUnavailable by name, never a fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AiLabUnavailable, aiLabPython, moduleFailure, mergeRun, planRun, providerCachePath } from '../scripts/lib/ai-lab.mjs';

const POST_REVIEW = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'post-review.js');

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-ailab-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the provider cache sits next to CC_MARKET_CONFIG_PATH', () => {
  assert.equal(providerCachePath({ CC_MARKET_CONFIG_PATH: join('x', 'reg.json') }), join('x', 'provider-cache.json'));
});

test('no provider cache is AiLabUnavailable naming the cache and the remedy', () => withDir((dir) => {
  const cache = join(dir, 'provider-cache.json');
  assert.throws(() => aiLabPython(cache), (e) => e instanceof AiLabUnavailable && e.message.includes(cache) && /setup/.test(e.message));
}));

test('a recorded interpreter that is gone is AiLabUnavailable naming it', () => withDir((dir) => {
  const cache = join(dir, 'provider-cache.json');
  writeFileSync(cache, JSON.stringify({ python: join(dir, 'gone', 'python.exe') }));
  assert.throws(() => aiLabPython(cache), (e) => e instanceof AiLabUnavailable && e.message.includes('gone'));
}));

test('an interpreter without ai-lab is AiLabUnavailable, not a merge of our own', () => {
  // node stands in for an interpreter that cannot run `-m ai_lab.review.merge`.
  assert.throws(() => mergeRun({ range: 'HEAD', date: '2026-10-20', profiles: [], reviewers: [] }, { python: process.execPath }),
    (e) => e instanceof Error && /ai_lab\.review\.merge exited|AiLabUnavailable/.test(`${e.name} ${e.message}`));
});

test('post-review without ai-lab exits non-zero naming AiLabUnavailable', () => withDir((dir) => {
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: 'run-1', started_at: '2000-01-01T00:00:00.000Z', date: '2026-06-21', range: 'HEAD', sink: 'memory',
    profiles: [{ key: 'diff', label: 'diff review' }], reviewers: [{ name: 'diff', provider: 'codex', status: 'pending' }] }));
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ run_id: 'run-1', results: [] }));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CC_MARKET_CONFIG_PATH: join(dir, 'reg.json') };
  assert.throws(() => execFileSync('node', [POST_REVIEW, '--plan', join(dir, 'plan.json'), '--raw', join(dir, 'raw.json')],
    { cwd: dir, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true }), (e) => /AiLabUnavailable: no provider cache/.test(e.stderr));
}));

test('an ai-lab older than the merge or the planner module is AiLabUnavailable asking for an upgrade', () => {
  for (const module of ['ai_lab.review.merge', 'ai_lab.review.plan']) {
    const e = moduleFailure(module, { status: 1, stderr: `No module named ${module}\n` }, 'py');
    assert.ok(e instanceof AiLabUnavailable && /upgrade/.test(e.message) && e.message.includes(module), module);
  }
});

test('an interpreter without ai-lab cannot plan: no planner of our own', () => {
  assert.throws(() => planRun({ run_id: 'r' }, { python: process.execPath }),
    (e) => e instanceof Error && /ai_lab\.review\.plan exited|AiLabUnavailable/.test(`${e.name} ${e.message}`));
});

// ── Through the installed ai-lab (the provider cache's interpreter), as post-review's suite does ──

const MANIFEST = { mode: 'review', range: 'HEAD', stats: {}, excludedSummary: '', diff: '+x' };
const REQUEST = { manifest: MANIFEST, run_id: 'r', started_at: 't', date: '2026-10-25', seed: 0 };

test('ai-lab plans the run: a forced profile on an available provider is pending with its prompt', () => {
  const plan = planRun({ ...REQUEST, forced: 'diff', available: ['claude'] });
  assert.equal(plan.run_id, 'r');
  assert.deepEqual(plan.reviewers.map((r) => [r.name, r.provider, r.status]), [['diff', 'claude', 'pending']]);
  assert.match(plan.reviewers[0].prompt, /\+x/);
  assert.equal(typeof plan.high_confidence, 'string');
});

test('a request ai-lab refuses is a plain Error naming its reason', () => {
  assert.throws(() => planRun({ ...REQUEST, forced: 'nope', available: ['claude'] }),
    (e) => !(e instanceof AiLabUnavailable) && /ai_lab\.review\.plan exited 2: refused: unknown profile nope/.test(e.message));
});

test('no ai_lab at all is AiLabUnavailable naming the install', () => {
  const e = moduleFailure('ai_lab.review.merge', { status: 1, stderr: "ModuleNotFoundError: No module named 'ai_lab'\n" }, 'py');
  assert.ok(e instanceof AiLabUnavailable && /not installed/.test(e.message));
});

test('a refused record is a plain Error carrying the reason ai-lab gave', () => {
  const e = moduleFailure('ai_lab.review.merge', { status: 2, stderr: 'refused: the run record on stdin is not JSON\n' }, 'py');
  assert.ok(!(e instanceof AiLabUnavailable) && /exited 2: refused: /.test(e.message));
});
