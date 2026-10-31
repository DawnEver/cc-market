// Runtime knowledge must describe retention, not the retired fixed-cap treadmill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const reference = name => readFileSync(new URL(`../skills/rem/reference/${name}.md`, import.meta.url), 'utf8');

test('active REM instructions never prescribe retired count-based eviction or advisory values', () => {
  for (const name of ['memory-conventions', 'standard-procedure', 'scripts', 'crystallize']) {
    const text = reference(name);
    assert.doesNotMatch(text, /(?:enforce|own|toward|its own)\s+(?:a\s+|the\s+)?20[- ]entry\s+cap/i, name);
    assert.doesNotMatch(text, /max\s+20\s+short|index\s*>\s*20|drop oldest short-term|(?:warns if|memory index)\s*≥\s*20/i, name);
  }
});

test('runtime memory policy: derived visibility, never deletion, no access bookkeeping', () => {
  const text = reference('memory-conventions');
  assert.match(text, /merged_from/);
  assert.match(text, /no memory entry is ever deleted/i);
  assert.match(text, /never writes/i);
  assert.doesNotMatch(text, /MEMORY\.full\.md|tier: long|access_count/);
});

// Retired scripts leave no trace in the plugin's own instructions.
const RETIRED = /\b(?:retire-memory|prune-memory|touch-memory|stamp-memory|repair-overcapacity|task-engine)\.js\b|\b(?:stamp|task-lib)\.mjs\b/;

test('no rem instruction names a retired script', () => {
  const root = new URL('../', import.meta.url);
  const files = ['README.md', 'AGENTS.md', 'docs/architecture.md', '.claude/rules/invariants.md'];
  for (const dir of ['skills']) {
    for (const f of readdirSync(new URL(dir + '/', root), { recursive: true })) {
      if (String(f).endsWith('.md')) files.push(`${dir}/${String(f).replaceAll('\\', '/')}`);
    }
  }
  const offenders = files.filter(f => RETIRED.test(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(offenders, []);
});
