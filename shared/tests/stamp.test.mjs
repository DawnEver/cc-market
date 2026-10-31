// stamp.test.mjs — shared/stamp.mjs: memory index entry primitives + upsertIndexEntry
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatIndexEntry, parseIndexEntry, parseIndex, normalizeMemoryPath, upsertIndexEntry,
} from '../stamp.mjs';

describe('index entry primitives', () => {
  it('format → parse round-trip', () => {
    const entry = {
      date: '2026-07-03', title: 'sharp-review-2026-07-03',
      path: '2026/07/03/sharp-review.md', created: '2026-07-03', accessed: '2026-07-03',
    };
    const line = formatIndexEntry(entry);
    const parsed = parseIndexEntry(line);
    assert.ok(parsed);
    assert.equal(parsed.title, entry.title);
    assert.equal(parsed.path, entry.path);
    assert.equal(parsed.created, entry.created);
    assert.equal(parsed.accessed, entry.accessed);
  });

  it('parseIndexEntry rejects non-entry lines', () => {
    assert.equal(parseIndexEntry('# Memory Index'), null);
    assert.equal(parseIndexEntry('- cc-market → see cc-market/.claude/rules/MEMORY.md'), null);
  });

  it('normalizeMemoryPath converts legacy flat date dirs', () => {
    assert.equal(normalizeMemoryPath('2026-07-03/x.md'), '2026/07/03/x.md');
    assert.equal(normalizeMemoryPath('2026/07/03/x.md'), '2026/07/03/x.md');
  });

  it('parseIndex splits header and entries', () => {
    const content = [
      '# Memory Index', '', '## Entries',
      formatIndexEntry({ date: '2026-07-01', title: 'a', path: '2026/07/01/a.md', created: '2026-07-01', accessed: '2026-07-01' }),
    ].join('\n');
    const { header, entries } = parseIndex(content);
    assert.equal(entries.length, 1);
    assert.ok(header.includes('# Memory Index'));
  });
});

describe('upsertIndexEntry', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stamp-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const indexFile = () => join(root, '.claude', 'rules', 'MEMORY.md');

  it('creates a minimal index when MEMORY.md is missing', () => {
    upsertIndexEntry(root, '2026/07/03/sharp-review.md', { name: 'sharp-review-2026-07-03', date: '2026-07-03' });
    assert.ok(existsSync(indexFile()));
    const { entries } = parseIndex(readFileSync(indexFile(), 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, '2026/07/03/sharp-review.md');
  });

  it('prepends to an existing index, preserving header and other entries', () => {
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    const existing = formatIndexEntry({ date: '2026-06-30', title: 'old', path: '2026/06/30/old.md', created: '2026-06-30', accessed: '2026-06-30' });
    writeFileSync(indexFile(), `# Memory Index\n\n## Scoped\n\n- sub → see sub/.claude/rules/MEMORY.md\n\n## Entries\n${existing}\n`, 'utf8');
    upsertIndexEntry(root, '2026/07/03/sharp-review.md', { name: 'sr', date: '2026-07-03' });
    const content = readFileSync(indexFile(), 'utf8');
    assert.ok(content.includes('## Scoped'));
    const { entries } = parseIndex(content);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].path, '2026/07/03/sharp-review.md');
    assert.equal(entries[1].path, '2026/06/30/old.md');
  });

  it('replaces an existing entry for the same path (no duplicates)', () => {
    upsertIndexEntry(root, '2026/07/03/sharp-review.md', { name: 'first', date: '2026-07-03' });
    upsertIndexEntry(root, '2026/07/03/sharp-review.md', { name: 'second', date: '2026-07-03' });
    const { entries } = parseIndex(readFileSync(indexFile(), 'utf8'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'second');
  });

  it('drops the "(no entries)" placeholder when adding the first entry', () => {
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    writeFileSync(indexFile(), '# Memory Index\n\n## Entries\n\n_(no entries)_\n', 'utf8');
    upsertIndexEntry(root, '2026/07/03/a.md', { name: 'a', date: '2026-07-03' });
    const content = readFileSync(indexFile(), 'utf8');
    assert.ok(!content.includes('_(no entries)_'));
    assert.equal(parseIndex(content).entries.length, 1);
  });

  it('derives created from the path date segment', () => {
    upsertIndexEntry(root, '2026/07/01/a.md', { name: 'a', date: '2026-07-03' });
    const { entries } = parseIndex(readFileSync(indexFile(), 'utf8'));
    assert.equal(entries[0].created, '2026-07-01');
    assert.equal(entries[0].accessed, '2026-07-03');
  });
});
