// prompts-overlap.test.mjs — mode templates must NOT restate universal
// principles (the GLOBAL-AGENTS.md layer owns those). This guard exists so a
// future edit cannot quietly reintroduce dual-source instructions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
// Key phrases owned by the GLOBAL layer (universal principles / communication).
const GLOBAL_OWNED = [
  /deliver the requested work at full scope/i,
  /complete the task fully/i,
  /first principles/i,
  /be concise/i,
  /no emojis/i,
  /tests before commit/i,
  /failing test first/i,
  /reversible actions are free/i,
];

test('mode templates do not restate GLOBAL-owned principles', () => {
  for (const f of ['task.md', 'review.md']) {
    const text = readFileSync(join(PROMPTS_DIR, f), 'utf8');
    for (const pat of GLOBAL_OWNED) {
      assert.doesNotMatch(text, pat, `${f} must not contain GLOBAL-owned phrasing: ${pat}`);
    }
  }
});

test('mode templates exist and are non-trivial', () => {
  const task = readFileSync(join(PROMPTS_DIR, 'task.md'), 'utf8');
  const review = readFileSync(join(PROMPTS_DIR, 'review.md'), 'utf8');
  assert.ok(task.trim().length > 50, 'task.md should carry mode-specific instructions');
  assert.ok(review.includes('Adversarial'), 'review.md keeps its mode-specific stance');
  assert.ok(review.includes('skepticism'), 'review adversarial stance preserved');
});
