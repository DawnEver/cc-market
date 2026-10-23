// The reviewer prompt is paid for on every review: its fixed part (everything but the diff and the
// manifest) has a declared ceiling, the current size plus a small margin, that may only go down.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadMethod } from '../scripts/lib/method.mjs';
import { renderReviewerPrompt } from '../scripts/lib/prompt.mjs';

// Characters of the largest rendered prompt with an empty diff and manifest.
export const PROMPT_BUDGET_CHARS = 3300;
// How far the ceiling may sit above the largest prompt before it must be lowered.
const MARGIN_CHARS = 100;

const EMPTY = { range: '', excludedSummary: '', diff: '', manifestText: '' };

export function fixedPrompts(method) {
  const out = [];
  for (const profile of Object.values(method.profiles)) {
    for (const mode of Object.keys(method.contexts[profile.context])) {
      const rendered = renderReviewerPrompt(profile, { ...EMPTY, mode }, method);
      if (rendered.prompt !== undefined) out.push({ key: `${profile.key}/${mode}`, chars: rendered.prompt.length });
    }
  }
  return out;
}

const over = (prompts) => prompts.filter((p) => p.chars > PROMPT_BUDGET_CHARS).map((p) => `${p.key}: ${p.chars}`);

test('every reviewer prompt without its diff or manifest fits the budget, and the budget is tight', () => {
  const prompts = fixedPrompts(loadMethod());
  assert.ok(prompts.length >= 3, 'a scan that renders nothing passes anything');
  assert.deepEqual(over(prompts), []);
  const largest = Math.max(...prompts.map((p) => p.chars));
  assert.ok(PROMPT_BUDGET_CHARS - largest <= MARGIN_CHARS, `largest is ${largest}; lower the ceiling`);
});

test('planted control: a profile whose framing overflows the budget is convicted', () => {
  const method = loadMethod();
  const [first] = Object.values(method.profiles);
  const planted = { ...first, key: 'planted', framing: 'x'.repeat(PROMPT_BUDGET_CHARS) };
  const prompts = fixedPrompts({ ...method, profiles: { planted } });
  assert.ok(over(prompts).length > 0);
});

test('the prompt schema omits the ids the principles partial lists, and validation keeps them', () => {
  const m = loadMethod();
  const field = m.principles.finding_field;
  assert.equal(m.promptSchema.properties[field].items.enum, undefined);
  assert.deepEqual(m.findingSchema.properties[field].items.enum, m.principleList.map((p) => p.id));
});
