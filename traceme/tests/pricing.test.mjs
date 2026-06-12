import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Isolate from the real ~/.claude/traceme/model_pricing.json — set the env
// override BEFORE importing the module (PRICING_FILE is captured at load).
const PRICING_FILE = join(tmpdir(), `traceme-pricing-${randomUUID()}.json`);
process.env.TRACEME_PRICING_FILE = PRICING_FILE;

// Dot-spelled keys (the on-disk default format) vs. dash-spelled model ids
// (what transcripts actually contain) — the case the old startsWith missed.
const PRICING = {
  'claude-fable-5':    { input: 10.0, output: 50.0, cache_write: 12.5, cache_read: 1.0 },
  'claude-opus-4.8':   { input: 5.0,  output: 25.0, cache_write: 6.25, cache_read: 0.5 },
  'claude-opus-4':     { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4.6': { input: 3.0,  output: 15.0, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4.5':  { input: 1.0,  output: 5.0,  cache_write: 1.25, cache_read: 0.1 },
};
writeFileSync(PRICING_FILE, JSON.stringify(PRICING), 'utf8');

const { getPricing, calcCost } = await import('../scripts/pricing.mjs');

describe('pricing model matching', () => {
  after(() => { try { unlinkSync(PRICING_FILE); } catch {} });

  it('dash-spelled current model binds to the dot-spelled tier (not the older one)', () => {
    // Regression: 'claude-opus-4-8' used to fall through to 'claude-opus-4' ($15) — 3× overcharge.
    assert.equal(getPricing('claude-opus-4-8').input, 5.0);
    assert.equal(getPricing('claude-opus-4-8').output, 25.0);
  });

  it('longest canonical prefix wins over a shorter shadowing key', () => {
    assert.equal(getPricing('claude-opus-4-8').input, 5.0);   // not 15 (claude-opus-4)
    assert.equal(getPricing('claude-opus-4-20250101').input, 15.0); // genuine opus-4 → older tier
  });

  it('dated suffix still matches (haiku 4.5)', () => {
    assert.equal(getPricing('claude-haiku-4-5-20251001').input, 1.0);
  });

  it('bare aliases resolve to the canonical current model', () => {
    assert.equal(getPricing('opus').input, 5.0);
    assert.equal(getPricing('sonnet').input, 3.0);
    assert.equal(getPricing('haiku').input, 1.0);
    assert.equal(getPricing('fable').input, 10.0);
  });

  it('unknown model falls back to sonnet pricing', () => {
    assert.equal(getPricing('mystery-model-9').input, 3.0);
  });

  it('calcCost uses the resolved tier', () => {
    const cost = calcCost({ input_tokens: 1_000_000 }, 'claude-opus-4-8');
    assert.equal(cost, 5.0); // 1M input × $5/M — would have been $15 under the bug
  });
});
