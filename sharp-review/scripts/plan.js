#!/usr/bin/env node
// plan.js — plan one review run: collect the manifest here (git), then ai-lab plans it from the
// method (`python -m ai_lab.review.plan`: pick profiles, assign providers, render every reviewer's
// prompt; sharp-review keeps no method logic). Writes the plan to a run-scoped file and prints it as
// JSON; the host fans the reviewers out and hands the results to post-review.js.
//
//   node plan.js --available <p1,p2,...> [--mode interactive|headless] [--providers <p1,...>]
//                [--sources diff,docs] [--profile <key>] [--range <git range>] [--path <subdir>]
//                [--out <plan.json>]
//
// --available: the providers this host can actually run. --providers: the requested set
// (default: the project config's providers.<mode>, else the method's run_modes.<mode>); a
// requested provider that is not available is planned as unavailable, never substituted.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AiLabUnavailable, planRun, principlesFile, reviewPolicy } from './lib/ai-lab.mjs';
import { loadReviewConfig } from './lib/config.mjs';
import { collectManifest } from './lib/git-manifest.mjs';
import { INLINE_DIFF_LIMIT_DEFAULT } from './lib/manifest.mjs';
import { todayISO, findProjectRoot } from '../shared/lib.mjs';
import { finishGate } from './gate.mjs';

const ROOT = findProjectRoot();
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const list = (flag) => (arg(flag) || '').split(',').map((s) => s.trim()).filter(Boolean);

try {
  const config = loadReviewConfig(ROOT);
  // The review policy (scope, caps, principles) is dev-lab's; the wave thresholds that FIRE a review stay ours.
  const policy = reviewPolicy(ROOT);
  const manifest = collectManifest(ROOT, {
    policy,
    range: arg('--range') || 'HEAD',
    path: arg('--path'),
    limit: config.inlineDiffLimit ?? INLINE_DIFF_LIMIT_DEFAULT,
  });
  const now = new Date();
  const runId = randomUUID();
  const plan = planRun({
    config,
    manifest,
    sources: list('--sources'),
    forced: arg('--profile') || null,
    run_mode: arg('--mode') || 'interactive',
    requested: list('--providers'),
    available: list('--available'),
    run_id: runId,
    started_at: now.toISOString(),
    date: todayISO(now),
    seed: Math.floor(now.getTime() / 60000),
  }, { principles: principlesFile(policy) });
  const out = arg('--out') || join(tmpdir(), 'claude-sharp-review', `plan-${runId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  plan.plan_file = out;
  if (arg('--gate-token')) plan.gate_token = arg('--gate-token');
  writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8');
  if (!plan.reviewers.some(reviewer => reviewer.status === 'pending')) finishGate(ROOT, plan.gate_token, false);
  process.stdout.write(JSON.stringify(plan) + '\n');
} catch (e) {
  console.error(`[plan] ${e instanceof AiLabUnavailable ? `${e.name}: ` : ''}${e.message}`);
  process.exit(1);
}
