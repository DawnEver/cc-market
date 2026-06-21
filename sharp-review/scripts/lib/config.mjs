// config.mjs — tracked, shareable sharp-review config (NOT device-local runtime state).
//
// Static review config — profile weights, custom profiles, trigger thresholds — lives in a
// COMMITTED `.claude/sharp-review.json` so it travels with the repo (a team/repo decision like
// "this codebase leans on architecture surveys" must be shared, not stuck on one machine).
// Volatile runtime state (sessionId, wave, lastReviewRef, reviewCount, …) stays in the
// gitignored `.claude/.rem-state.json` under `reviewGate` — the two are deliberately separate.
//
// Shape of `.claude/sharp-review.json` (every key optional):
//   {
//     "profileWeights":      { "<profileKey>": number, ... },   // retune built-in weights / opt out (0)
//     "customProfiles":      [ { key, source, weight?, mode?, promptKind?, framing?, reviewScope?, label? } ],
//     "thresholds":          { "wave0": { lines, files }, "wave1": { lines, files } },
//     "inlineDiffLimit":     number,   // chars; review→agent mode cutover
//     "docsThreshold":       number,   // doc-file count that fires the docs source
//     "codebaseIntervalMin": number    // minutes between codebase surveys
//   }
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REVIEW_CONFIG_FILE = join('.claude', 'sharp-review.json');

// Read the tracked config for `root`. Returns {} on absent/invalid file — callers apply their
// own per-key defaults, so a missing config is always safe.
export function loadReviewConfig(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, REVIEW_CONFIG_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
