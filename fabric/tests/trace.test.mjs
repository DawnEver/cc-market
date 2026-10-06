import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitProviderTrace } from '../scripts/lib/trace.mjs';

test('emitProviderTrace is a no-op when traceme is not installed', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')), 'traceme');
  emitProviderTrace({ provider: 'x' }, dir);
  assert.equal(fs.existsSync(dir), false);
});

test('emitProviderTrace appends when the traceme dir exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  emitProviderTrace({ provider: 'x' }, dir);
  const lines = fs.readFileSync(path.join(dir, 'fabric_traces.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map(JSON.parse), [{ provider: 'x' }]);
});
