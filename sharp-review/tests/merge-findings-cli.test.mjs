/**
 * Integration tests for `merge-findings.js`: the stdout-only external seam where raw
 * per-reviewer findings are merged via the shared engine and printed as JSON without
 * writing any memory entry (the path content-review callers like ai-post use). Run:
 *   node --test cc-market/sharp-review/tests/merge-findings-cli.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'scripts', 'merge-findings.js');

function run(raw, date = '2026-06-29') {
  const dir = mkdtempSync(join(tmpdir(), 'merge-findings-'));
  try {
    const rawFile = join(dir, 'raw.json');
    writeFileSync(rawFile, JSON.stringify(raw), 'utf8');
    const out = execFileSync('node', [CLI, '--raw', rawFile, '--date', date], { encoding: 'utf8', windowsHide: true });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('merge-findings.js', () => {
  test('merges content-review findings, preserves custom fields, tags confidence', () => {
    const result = run({
      reviewers: [{ key: 'A', name: '读者代理人 (Opus)' }, { key: 'B', name: '读者代理人 (DeepSeek)' }],
      active: [{ key: 'A', name: '读者代理人 (Opus)' }, { key: 'B', name: '读者代理人 (DeepSeek)' }],
      idPrefix: 'CR-A',
      dedupKeyFields: ['location', 'dimension'],
      profileLabel: '读者代理人',
      rawResults: [
        { findings: [{ location: '开头', dimension: 'hook', rating: '2/5', issue: '套话' }] },
        { findings: [{ location: '开头', dimension: 'hook', rating: '2/5', issue: '套话' }] },
      ],
    });
    assert.equal(result.merged.length, 1);
    assert.equal(result.merged[0].id, 'CR-A-20260629-001');
    assert.equal(result.merged[0].location, '开头');
    assert.equal(result.merged[0].issue, '套话');
    assert.match(result.merged[0].confidence, /high-confidence/);
    assert.match(result.summary, /1 issues \(1 high-confidence\)/);
  });

  test('tolerates a failed (null) reviewer slot', () => {
    const result = run({
      reviewers: [{ key: 'A', name: 'A' }, { key: 'B', name: 'B' }],
      active: [{ key: 'A', name: 'A' }, { key: 'B', name: 'B' }],
      idPrefix: 'CR-B',
      dedupKeyFields: ['location', 'dimension'],
      rawResults: [{ findings: [{ location: 'code', dimension: 'syntax', issue: 'x' }] }, null],
    });
    assert.equal(result.merged.length, 1);
    assert.equal(result.merged[0].confidence, 'single-reviewer');
  });
});
