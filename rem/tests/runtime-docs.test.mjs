// Runtime knowledge must describe retention, not the retired fixed-cap treadmill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const reference = name => readFileSync(new URL(`../skills/rem/reference/${name}.md`, import.meta.url), 'utf8');

test('active REM instructions never prescribe retired count-based eviction or advisory values', () => {
  for (const name of ['memory-conventions', 'standard-procedure', 'scripts', 'crystallize']) {
    const text = reference(name);
    assert.doesNotMatch(text, /(?:enforce|own|toward|its own)\s+(?:a\s+|the\s+)?20[- ]entry\s+cap/i, name);
    assert.doesNotMatch(text, /max\s+20\s+short|index\s*>\s*20|drop oldest short-term|(?:warns if|memory index)\s*≥\s*20/i, name);
  }
});

test('runtime memory policy describes the tree-only lifecycle, not access bookkeeping', () => {
  const text = reference('memory-conventions');
  assert.match(text, /merged_from/);
  assert.match(text, /retire-memory.js/);
  assert.match(text, /HOT_MAX/);
  assert.match(text, /never writes/i);
  assert.doesNotMatch(text, /_meta.json|touch-memory|prune-memory|MEMORY.full.md|tier: long/);
});
