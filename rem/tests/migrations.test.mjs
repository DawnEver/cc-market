/**
 * Tests for rem/migrations/migrate.mjs — "migrate to latest" project migration.
 * Run: node --test cc-market/rem/tests/migrations.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrate } from '../migrations/migrate.mjs';

describe('rem migrate()', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('removes empty legacy .claude/memory/tasks/ tree', async () => {
    const legacyTasksDir = path.join(projectRoot, '.claude', 'memory', 'tasks', 'archive');
    fs.mkdirSync(legacyTasksDir, { recursive: true });

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('legacy .claude/memory/tasks')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'memory', 'tasks')), false);
  });

  test('does not remove a non-empty legacy tasks dir', async () => {
    const legacyTasksDir = path.join(projectRoot, '.claude', 'memory', 'tasks');
    fs.mkdirSync(legacyTasksDir, { recursive: true });
    fs.writeFileSync(path.join(legacyTasksDir, 'tasks.md'), '# leftover content');

    await migrate(projectRoot);

    assert.equal(fs.existsSync(path.join(legacyTasksDir, 'tasks.md')), true);
  });

  test('stamps memory files missing frontmatter fields via stamp-memory', async () => {
    const dayDir = path.join(projectRoot, '.claude', 'memory', '2026', '06', '10');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, 'example.md'),
      '---\nname: example\ndescription: an example memory\n---\n\nbody\n',
    );

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('stamped')));
    const content = fs.readFileSync(path.join(dayDir, 'example.md'), 'utf8');
    assert.match(content, /^created:/m);
    assert.match(content, /^accessed:/m);
    assert.match(content, /^tier:/m);
  });

  test('is a no-op (changed: false) once a project is current', async () => {
    const dayDir = path.join(projectRoot, '.claude', 'memory', '2026', '06', '10');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, 'example.md'),
      '---\nname: example\ndescription: an example memory\ncreated: 2026-06-10\naccessed: 2026-06-10\ntier: short\n---\n\nbody\n',
    );

    await migrate(projectRoot); // first pass creates the index, etc.
    const { changed, summary } = await migrate(projectRoot); // second pass should be a no-op

    assert.equal(changed, false);
    assert.deepEqual(summary, []);
  });

  test('returns no-op when .claude/ does not exist', async () => {
    const { changed, summary } = await migrate(projectRoot);
    assert.equal(changed, false);
    assert.deepEqual(summary, []);
  });

  test('splits a legacy monthly archive rollup into per-day canonical files', async () => {
    const legacyDir = path.join(projectRoot, '.claude', 'memory', 'tasks', 'archive', '2026');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, '06.md'),
      '# Resolved Tasks — 2026-06\n\n' +
        '- [x] SR-20260604-001 [MEDIUM] first finding\n' +
        '      → FIXED 2026-06-04: marked resolved\n\n' +
        '- [x] SR-20260608-001 [HIGH] second finding\n' +
        '      → FIXED 2026-06-08: marked resolved\n',
    );

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('migrated 2 resolved task(s)')));

    const day04 = fs.readFileSync(path.join(projectRoot, '.claude', 'tasks', 'archive', '2026', '06', '04.md'), 'utf8');
    assert.match(day04, /SR-20260604-001/);
    const day08 = fs.readFileSync(path.join(projectRoot, '.claude', 'tasks', 'archive', '2026', '06', '08.md'), 'utf8');
    assert.match(day08, /SR-20260608-001/);

    // legacy tree fully consumed and removed
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'memory', 'tasks')), false);
  });

  test('migrates a non-canonical flat archive file (YYYY-MM.md) and dedupes against existing entries', async () => {
    const archiveDir = path.join(projectRoot, '.claude', 'tasks', 'archive');
    fs.mkdirSync(path.join(archiveDir, '2026', '06'), { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, '2026', '06', '04.md'),
      '# Resolved Tasks — 2026-06-04\n\n' +
        '- [x] SR-20260604-001 [MEDIUM] already archived\n' +
        '      → FIXED 2026-06-04: marked resolved\n',
    );
    fs.writeFileSync(
      path.join(archiveDir, '2026-06.md'),
      '# Resolved Tasks — 2026-06\n\n' +
        '- [x] SR-20260604-001 [MEDIUM] already archived\n' +
        '      → FIXED 2026-06-04: marked resolved\n\n' +
        '- [x] SR-20260604-002 [LOW] new finding\n' +
        '      → FIXED 2026-06-04: marked resolved\n',
    );

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('migrated 1 resolved task(s)')));

    const day04 = fs.readFileSync(path.join(archiveDir, '2026', '06', '04.md'), 'utf8');
    assert.match(day04, /SR-20260604-001/);
    assert.match(day04, /SR-20260604-002/);
    assert.equal((day04.match(/SR-20260604-001/g) || []).length, 1);

    // non-canonical rollup removed once fully migrated
    assert.equal(fs.existsSync(path.join(archiveDir, '2026-06.md')), false);
  });

  test('removes stray legacy .claude/.retro_state.json', async () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', '.retro_state.json'), '{}');

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('.retro_state.json')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', '.retro_state.json')), false);
  });

  test('preserves non-entry content in a non-canonical archive file', async () => {
    const archiveDir = path.join(projectRoot, '.claude', 'tasks', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'notes.md'),
      '# Notes\n\nSome manual note unrelated to resolved tasks.\n\n' +
        '- [x] SR-20260604-001 [MEDIUM] resolved item\n' +
        '      → FIXED 2026-06-04: marked resolved\n',
    );

    const { changed } = await migrate(projectRoot);

    assert.equal(changed, true);
    const day04 = fs.readFileSync(path.join(archiveDir, '2026', '06', '04.md'), 'utf8');
    assert.match(day04, /SR-20260604-001/);

    const remaining = fs.readFileSync(path.join(archiveDir, 'notes.md'), 'utf8');
    assert.match(remaining, /Some manual note unrelated to resolved tasks/);
    assert.doesNotMatch(remaining, /SR-20260604-001/);
  });
});
