import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TRACEME_DIR } from './lib.mjs';

const PRICING_FILE = process.env.TRACEME_PRICING_FILE || join(TRACEME_DIR, 'model_pricing.json');

// Default pricing — updated 2026-06-11.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
//         https://api-docs.deepseek.com/quick_start/pricing
const DEFAULT_PRICING = {
  'claude-fable-5':          { input: 10.00, output: 50.00, cache_write: 12.50, cache_read: 1.00 },
  'claude-mythos-5':         { input: 10.00, output: 50.00, cache_write: 12.50, cache_read: 1.00 },
  'claude-opus-4.8':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.7':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.6':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4.5':         { input: 5.00,  output: 25.00, cache_write: 6.25,  cache_read: 0.50 },
  'claude-opus-4':           { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4.6':       { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4.5':       { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-sonnet-4':         { input: 3.00,  output: 15.00, cache_write: 3.75,  cache_read: 0.30 },
  'claude-haiku-4.5':        { input: 1.00,  output: 5.00,  cache_write: 1.25,  cache_read: 0.10 },
  'claude-haiku-3.5':        { input: 0.80,  output: 4.00,  cache_write: 1.00,  cache_read: 0.08 },
  'deepseek-v4-pro':         { input: 0.435, output: 0.87,  cache_hit: 0.003625 },
  'deepseek-v4-flash':       { input: 0.14,  output: 0.28,  cache_hit: 0.0028 },
};

// Bare model aliases Claude Code emits (no version suffix) → canonical id.
const ALIASES = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
  mythos: 'claude-mythos-5',
};

// Canonicalize so dot/dash spelling can't desync key vs. model id.
// Real model ids use dashes (`claude-opus-4-8`); pricing keys historically
// used dots (`claude-opus-4.8`) — without this, `startsWith` silently fell
// through to the older `claude-opus-4` tier and overcharged 3×.
function canon(s) { return s.toLowerCase().replace(/\./g, '-'); }

let _pricing = null;

export function loadPricing() {
  if (_pricing) return _pricing;
  try {
    if (existsSync(PRICING_FILE)) {
      _pricing = JSON.parse(readFileSync(PRICING_FILE, 'utf8'));
      return _pricing;
    }
  } catch {}
  // First run: write defaults so the user can discover and edit
  try { writeFileSync(PRICING_FILE, JSON.stringify(DEFAULT_PRICING, null, 2) + '\n', 'utf8'); } catch {}
  _pricing = DEFAULT_PRICING;
  return _pricing;
}

export function getPricing(model) {
  const pricing = loadPricing();
  let m = canon(model || '');
  if (ALIASES[m]) m = canon(ALIASES[m]);
  // Longest matching canonical prefix wins, so `claude-opus-4-8` binds to
  // `claude-opus-4.8`, never the shorter `claude-opus-4`.
  let best = null, bestLen = -1;
  for (const [key, price] of Object.entries(pricing)) {
    const ck = canon(key);
    if (m.startsWith(ck) && ck.length > bestLen) { best = price; bestLen = ck.length; }
  }
  return best || pricing['claude-sonnet-4.6'] || DEFAULT_PRICING['claude-sonnet-4.6'];
}

export function calcCost(usage, model) {
  const p = getPricing(model);
  const inputCost      = (usage.input_tokens || 0) / 1_000_000 * p.input;
  const outputCost     = (usage.output_tokens || 0) / 1_000_000 * p.output;
  const cacheReadCost  = (usage.cache_read_input_tokens || 0) / 1_000_000 * (p.cache_hit || p.cache_read || 0);
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) / 1_000_000 * (p.cache_write || p.input);
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
