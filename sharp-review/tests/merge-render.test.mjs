/**
 * Tests for the host-agnostic merge + render logic in lib.mjs.
 * Run: node --test cc-market/sharp-review/tests/merge-render.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDedupKey, mergeFindings, renderReviewMarkdown } from '../scripts/lib.mjs';

describe('buildDedupKey', () => {
  test('lowercases and joins configured fields', () => {
    assert.equal(buildDedupKey({ file: 'Src/A.js', summary: 'Bug Here' }), 'src/a.js|bug here');
  });
  test('defaults missing fields to empty', () => {
    assert.equal(buildDedupKey({ file: 'a.js' }), 'a.js|');
  });
});

describe('mergeFindings', () => {
  const date = '2026-06-21';

  test('dedups across reviewers and tags high-confidence on ≥2', () => {
    const raw = [
      { findings: [{ file: 'a.js', summary: 'leak', severity: 'HIGH', category: 'Bug' }] },
      { findings: [{ file: 'a.js', summary: 'leak', severity: 'HIGH', category: 'Bug' }] },
    ];
    const merged = mergeFindings(raw, { date });
    assert.equal(merged.length, 1);
    assert.match(merged[0].confidence, /high-confidence/);
    assert.equal(merged[0].id, 'SR-20260621-001');
  });

  test('single-reviewer finding is tagged single-reviewer', () => {
    const merged = mergeFindings([{ findings: [{ file: 'b.js', summary: 'x' }] }], { date });
    assert.equal(merged[0].confidence, 'single-reviewer');
    assert.equal(merged[0].severity, 'MEDIUM'); // default
    assert.equal(merged[0].category, 'Bug'); // default
  });

  test('assigns sequential ids and tolerates null/empty reviewer results', () => {
    const raw = [
      null,
      { findings: [{ file: 'a.js', summary: 'one' }, { file: 'b.js', summary: 'two' }] },
      { findings: [] },
    ];
    const merged = mergeFindings(raw, { date });
    assert.deepEqual(merged.map((f) => f.id), ['SR-20260621-001', 'SR-20260621-002']);
  });

  test('honors custom idPrefix and dedupKeyFields', () => {
    const raw = [
      { findings: [{ file: 'a.js', summary: 'p1', category: 'Bug' }] },
      { findings: [{ file: 'a.js', summary: 'p2', category: 'Bug' }] },
    ];
    // dedup only by file → the two collapse
    const merged = mergeFindings(raw, { date, idPrefix: 'XR', dedupKeyFields: ['file'] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'XR-20260621-001');
  });

  test('preserves arbitrary finding fields (content-review schema)', () => {
    // External callers (e.g. ai-post) use a non-code finding shape. The merge must
    // carry those fields through to `merged` — only `id`/`confidence` are added and
    // the code-shaped fields fall back to defaults.
    const raw = [
      { findings: [{ location: '开头', dimension: 'hook', rating: '2/5', issue: '套话', suggestion: '换具体事件' }] },
      { findings: [{ location: '开头', dimension: 'hook', rating: '2/5', issue: '套话', suggestion: '换具体事件' }] },
    ];
    const merged = mergeFindings(raw, { date, idPrefix: 'CR-A', dedupKeyFields: ['location', 'dimension'] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'CR-A-20260621-001');
    assert.equal(merged[0].location, '开头');
    assert.equal(merged[0].dimension, 'hook');
    assert.equal(merged[0].rating, '2/5');
    assert.equal(merged[0].issue, '套话');
    assert.match(merged[0].confidence, /high-confidence/);
  });
});

describe('renderReviewMarkdown', () => {
  const date = '2026-06-21';
  const reviewers = [
    { key: 'A', name: 'Codex' },
    { key: 'B', name: 'DeepSeek' },
    { key: 'C', name: 'Opus' },
  ];

  test('renders status, findings, and memory path', () => {
    const active = [reviewers[0], reviewers[1]];
    const slotResults = { A: { findings: [{}] }, B: { findings: [{}] } };
    const merged = mergeFindings([slotResults.A, slotResults.B].map(() => ({
      findings: [{ file: 'a.js', summary: 's', severity: 'HIGH', category: 'Bug' }],
    })), { date });
    const { markdown, reviewFile } = renderReviewMarkdown(merged, { reviewers, slotResults, active, date, profileLabel: 'diff' });

    assert.equal(reviewFile, '.claude/memory/2026/06/21/sharp-review.md');
    assert.match(markdown, /## Review 2026-06-21 \(session\) — diff/);
    assert.match(markdown, /- Reviewer A \(Codex\): OK/);
    assert.match(markdown, /- Reviewer C \(Opus\): skipped/);
    assert.match(markdown, /\[SR-20260621-001\] \[HIGH\] a\.js — s/);
  });

  test('flags partial reviewer success', () => {
    const active = [reviewers[0], reviewers[1]];
    const slotResults = { A: { findings: [{}] }, B: null };
    const { markdown } = renderReviewMarkdown([], { reviewers, slotResults, active, date });
    assert.match(markdown, /- Reviewer B \(DeepSeek\): FAILED/);
    assert.match(markdown, /Warning: only 1\/2 reviewers succeeded/);
  });
});
