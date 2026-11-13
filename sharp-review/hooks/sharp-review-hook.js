#!/usr/bin/env node
// sharp-review-hook.js — Claude Code and Codex Stop hook. It runs on every Stop but reviews
// only where switched on (stopHookEnabled, default off), so it reads that switch first and
// loads the review trigger (scripts/stop-review.mjs: wave gate, sources, dispatch) only then.

import { findProjectRoot, readStdinJSON, isMain } from '../shared/lib.mjs';
import { loadReviewConfig, stopHookEnabled } from '../scripts/lib/config.mjs';

if (isMain(import.meta)) {
  try {
    const input = readStdinJSON();
    const root = findProjectRoot(input.cwd || process.cwd());
    const reviewCfg = loadReviewConfig(root);
    if (stopHookEnabled(reviewCfg, process.env)) {
      const { review } = await import('../scripts/stop-review.mjs');
      review(input, root, reviewCfg);
    }
  } catch (e) {
    process.stderr.write(`[sharp-review] ${e.message}\n`);
    process.exitCode = 0;
  }
}
