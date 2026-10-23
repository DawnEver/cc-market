// Transient checkout-wide review claims. A dispatch is not evidence of a completed review.
import { join } from 'node:path';
import { withStateLock } from '../shared/state.mjs';
const CLAIM_MS = 30 * 60000;

export function claimReview(previous = {}, snapshot, { token, now }) {
  const gate = previous || {};
  if (gate.pending?.expiresAt > now) return { gate, dispatch: false };
  const sources = snapshot.sources.filter(key => snapshot.hashes[key] !== gate.reviewedHashes?.[key]);
  if (!sources.length) return { gate: { ...gate, pending: null, mode: 'none' }, dispatch: false };
  return {
    dispatch: true,
    gate: {
      ...gate, mode: 'once', reason: 'deterministic source threshold',
      pending: { token, sessionId: snapshot.sessionId, turnId: snapshot.turnId || null,
        startedAt: now, expiresAt: now + CLAIM_MS, head: snapshot.head, stat: snapshot.stat,
        wave: snapshot.wave, sources, hashes: Object.fromEntries(sources.map(key => [key, snapshot.hashes[key]])),
        reasons: Object.fromEntries(sources.map(key => [key, snapshot.reasons[key]])) },
    },
  };
}

export function completeReview(gate, token, success, now = Date.now()) {
  if (!gate?.pending || gate.pending.token !== token) return gate;
  const pending = gate.pending;
  return {
    ...gate, pending: null, lastAttemptAt: now,
    ...(success && pending.expiresAt > now ? {
      lastReviewAt: now, lastReviewRef: pending.head, lastReviewDiff: pending.stat,
      wave: pending.wave, reviewedHashes: { ...gate.reviewedHashes, ...pending.hashes },
    } : {}),
  };
}

export function finishGate(root, token, success) {
  if (!token) return;
  const saved = withStateLock(join(root, '.claude', '.rem-state.json'), state => {
    state.reviewGate = completeReview(state.reviewGate, token, success);
  }, { atomic: true, onTimeout: 'throw' });
  if (!saved?.persisted) throw new Error('Could not persist review gate completion.');
}
