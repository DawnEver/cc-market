// Tests for engine/context.mjs — the context-window limit table (model id → window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextLimitFor } from '../engine/context.mjs';

test('contextLimitFor reads windows the id encodes', () => {
  assert.equal(contextLimitFor('deepseek-v4-flash[1m]'), 1_000_000);
  assert.equal(contextLimitFor('deepseek-v4-pro[1m]'), 1_000_000);
  assert.equal(contextLimitFor('k3[1m]'), 1_000_000);
  assert.equal(contextLimitFor('k3-256k'), 256_000);
  assert.equal(contextLimitFor('some-model-128k'), 128_000);
});

test('contextLimitFor maps the claude family and its console aliases', () => {
  assert.equal(contextLimitFor('claude-haiku-4-5'), 200_000);
  assert.equal(contextLimitFor('claude-opus-5'), 200_000);
  assert.equal(contextLimitFor('haiku'), 200_000);
  assert.equal(contextLimitFor('opus'), 200_000);
});

test('unknown models report null — the UI shows tokens without a fabricated %', () => {
  assert.equal(contextLimitFor('kimi-for-coding'), null);
  assert.equal(contextLimitFor(null), null);
  assert.equal(contextLimitFor(undefined), null);
  assert.equal(contextLimitFor('totally-new-model'), null);
});
