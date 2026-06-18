// sources.mjs — Sharp Review source-adapter registry (pure logic).
//
// A *source* is a trigger adapter: given a context snapshot it decides whether a review of its
// kind should fire. The hook does all the git/clock I/O and hands the adapters a plain `ctx`;
// every `triggerScore` is pure (no I/O, no clock) so it is fully testable.
//
// ctx shape:
//   {
//     changedFiles: string[],               // working-tree changed paths
//     diffStat: { lines, files },           // accumulated diff stat vs last-reviewed ref
//     waveThreshold: { lines, files },      // current wave's diff gate (from the hook)
//     minutesSinceLastReview: number,       // for time-based sources
//     docsThreshold: number,                // doc-file count that fires the docs source
//     codebaseIntervalMin: number,          // minutes between codebase surveys
//   }
//
// Each source's triggerScore returns { fired, score, threshold, reason }. evaluateSources
// aggregates the fired keys and their reasons.

import { isLockfile, isDoc } from './lib.mjs';

export { isLockfile, isDoc };

// Exported defaults, overridable via the ctx values the hook passes from reviewGate config.
export const DOCS_THRESHOLD_DEFAULT = 3;
export const CODEBASE_INTERVAL_MIN_DEFAULT = 10080; // 7 days

export const SOURCES = [
  {
    key: 'diff',
    // Mirrors the hook's wave gate exactly: fire when EITHER axis meets its threshold.
    triggerScore(ctx) {
      const { lines, files } = ctx.diffStat;
      const { lines: tl, files: tf } = ctx.waveThreshold;
      const fired = lines >= tl || files >= tf;
      return {
        fired,
        score: Math.max(lines, files),
        threshold: Math.min(tl, tf),
        reason: `diff ${lines}L/${files}F vs ${tl}L/${tf}F gate`,
      };
    },
  },
  {
    key: 'codebase',
    // Time-based architecture survey.
    triggerScore(ctx) {
      const m = ctx.minutesSinceLastReview;
      const t = ctx.codebaseIntervalMin ?? CODEBASE_INTERVAL_MIN_DEFAULT;
      return {
        fired: m >= t,
        score: m,
        threshold: t,
        reason: `${m}min since last review vs ${t}min interval`,
      };
    },
  },
  {
    key: 'deps',
    // Any changed lockfile.
    triggerScore(ctx) {
      const hits = ctx.changedFiles.filter(isLockfile);
      return {
        fired: hits.length > 0,
        score: hits.length,
        threshold: 1,
        reason: hits.length ? `lockfile changed: ${hits.join(', ')}` : 'no lockfile changes',
      };
    },
  },
  {
    key: 'docs',
    triggerScore(ctx) {
      const t = ctx.docsThreshold ?? DOCS_THRESHOLD_DEFAULT;
      const n = ctx.changedFiles.filter(isDoc).length;
      return {
        fired: n >= t,
        score: n,
        threshold: t,
        reason: `${n} doc file(s) changed vs ${t} threshold`,
      };
    },
  },
];

// Evaluate every source against ctx. Returns the fired source keys and a reason per fired key.
export function evaluateSources(ctx) {
  const fired = [];
  const reasons = {};
  for (const s of SOURCES) {
    const r = s.triggerScore(ctx);
    if (r.fired) {
      fired.push(s.key);
      reasons[s.key] = r.reason;
    }
  }
  return { fired, reasons };
}
