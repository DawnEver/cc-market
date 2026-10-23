// lib/ai-lab.mjs: the merge is ai-lab's; an absent ai-lab is AiLabUnavailable by name, never a fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AiLabUnavailable, aiLabPython, mergeRun, providerCachePath } from '../scripts/lib/ai-lab.mjs';
import { loadMethod } from '../scripts/lib/method.mjs';

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
  // node stands in for an interpreter that cannot run `-m ai_lab.review`.
  assert.throws(() => mergeRun({ range: 'HEAD', date: '2026-10-20', profiles: [], reviewers: [] }, loadMethod(), { python: process.execPath }),
    (e) => e instanceof Error && /ai_lab\.review merge exited|AiLabUnavailable/.test(`${e.name} ${e.message}`));
});

test('post-review without ai-lab exits non-zero naming AiLabUnavailable', () => withDir((dir) => {
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ run_id: 'run-1', started_at: '2000-01-01T00:00:00.000Z', date: '2026-06-21', range: 'HEAD', sink: 'memory',
    profiles: [{ key: 'diff', label: 'diff review' }], reviewers: [{ name: 'diff', provider: 'codex', status: 'pending' }] }));
  writeFileSync(join(dir, 'raw.json'), JSON.stringify({ run_id: 'run-1', results: [] }));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CC_MARKET_CONFIG_PATH: join(dir, 'reg.json') };
  assert.throws(() => execFileSync('node', [POST_REVIEW, '--plan', join(dir, 'plan.json'), '--raw', join(dir, 'raw.json')],
    { cwd: dir, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true }), (e) => /AiLabUnavailable: no provider cache/.test(e.stderr));
}));
