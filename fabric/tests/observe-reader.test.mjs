// Tests for engine/observe-reader.mjs — pairing, quota-probe filtering, summarize.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRows, pair, isQuotaProbe, mainTurns, summarize, summarizeFile } from '../engine/observe-reader.mjs';

const ROWS = [
  { t: 'request', id: 1, ts: 10, provider: 'deepseek', path: '/v1/messages', modelBefore: 'claude-haiku-4-5', modelAfter: 'deepseek-v4-flash', body: { messages: [{ role: 'user', content: 'hi' }] } },
  { t: 'response', id: 1, ts: 20, status: 200, body: 'event: message_start' },
  // quota probe — beta=true, max_tokens:1, 404
  { t: 'request', id: 2, ts: 11, provider: 'deepseek', path: '/v1/messages?beta=true', body: { max_tokens: 1, messages: [] } },
  { t: 'response', id: 2, ts: 12, status: 404, body: '' },
  // an error row
  { t: 'request', id: 3, ts: 13, provider: 'deepseek', path: '/v1/messages', body: { messages: [] } },
  { t: 'error', id: 3, ts: 14, message: 'upstream reset' },
];

test('pair groups rows by id in request order', () => {
  const paired = pair(ROWS);
  assert.equal(paired.length, 3);
  assert.equal(paired[0].id, 1);
  assert.equal(paired[0].response.status, 200);
  assert.equal(paired[2].error.message, 'upstream reset');
});

test('isQuotaProbe detects the beta=true max_tokens:1 probe', () => {
  const [q] = pair(ROWS).filter((e) => e.id === 2);
  assert.equal(isQuotaProbe(q), true);
  const [real] = pair(ROWS).filter((e) => e.id === 1);
  assert.equal(isQuotaProbe(real), false);
});

test('mainTurns keeps only real 200 /v1/messages turns', () => {
  const turns = mainTurns(ROWS);
  assert.equal(turns.length, 1, 'probe (404) and error turn excluded');
  assert.equal(turns[0].id, 1);
  assert.equal(turns[0].request.modelAfter, 'deepseek-v4-flash');
});

test('summarize rolls up counts, models, providers', () => {
  const s = summarize(ROWS);
  assert.equal(s.requests, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.mainTurns, 1);
  assert.deepEqual(s.models, ['deepseek-v4-flash']);
  assert.deepEqual(s.providers, ['deepseek']);
});

test('loadRows + summarizeFile round-trip through a file', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'reader-')), 'http.jsonl');
  writeFileSync(p, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(loadRows(p).length, 6);
  assert.equal(summarizeFile(p).mainTurns, 1);
});

test('loadRows tolerates a missing file', () => {
  assert.deepEqual(loadRows('/no/such/file.jsonl'), []);
});
