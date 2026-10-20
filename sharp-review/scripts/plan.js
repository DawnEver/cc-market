#!/usr/bin/env node
// plan.js — plan one review run from the method data: pick profiles, collect the manifest,
// assign providers, render every reviewer's prompt. Writes the plan to a run-scoped file and
// prints it as JSON; the host fans the reviewers out and hands the results to post-review.js.
//
//   node plan.js --available <p1,p2,...> [--mode interactive|headless] [--providers <p1,...>]
//                [--sources diff,docs] [--profile <key>] [--range <git range>] [--path <subdir>]
//                [--out <plan.json>]
//
// --available: the providers this host can actually run. --providers: the requested set
// (default: the project config's providers.<mode>, else method.json run_modes.<mode>); a
// requested provider that is not available is planned as unavailable, never substituted.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadMethod } from './lib/method.mjs';
import { loadReviewConfig } from './lib/config.mjs';
import { collectManifest } from './lib/git-manifest.mjs';
import { INLINE_DIFF_LIMIT_DEFAULT } from './lib/manifest.mjs';
import { buildPlan } from './lib/plan.mjs';
import { todayISO } from '../shared/lib.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const draws = (n) => Array.from({ length: n }, () => Math.random());
const list = (flag) => (arg(flag) || '').split(',').map((s) => s.trim()).filter(Boolean);

try {
  const method = loadMethod();
  const config = loadReviewConfig(ROOT);
  const manifest = collectManifest(ROOT, {
    range: arg('--range') || 'HEAD',
    path: arg('--path'),
    limit: config.inlineDiffLimit ?? INLINE_DIFF_LIMIT_DEFAULT,
  });
  const now = new Date();
  const runId = randomUUID();
  const plan = buildPlan({
    method,
    config,
    manifest,
    sources: list('--sources'),
    forced: arg('--profile'),
    runMode: arg('--mode') || 'interactive',
    requested: list('--providers'),
    available: list('--available'),
    rands: { pick: draws(method.pick.count), shuffle: draws(method.pick.count) },
    runId,
    startedAt: now.toISOString(),
    date: todayISO(now),
    seed: Math.floor(now.getTime() / 60000),
  });
  const out = arg('--out') || join(tmpdir(), 'claude-sharp-review', `plan-${runId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  plan.plan_file = out;
  writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(plan) + '\n');
} catch (e) {
  console.error(`[plan] ${e.message}`);
  process.exit(1);
}
