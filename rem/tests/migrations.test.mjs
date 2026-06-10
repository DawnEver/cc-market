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
});
