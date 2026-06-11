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

  test('strips volatile fields and imports into _meta.json', async () => {
    const dayDir = path.join(projectRoot, '.claude', 'memory', '2026', '06', '10');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, 'example.md'),
      '---\nname: example\ndescription: an example memory\ncreated: 2026-06-10\naccessed: 2026-06-10\ntier: short\n---\n\nbody\n',
    );

    const { changed } = await migrate(projectRoot);

    assert.equal(changed, true);
    // Volatile fields stripped from frontmatter
    const content = fs.readFileSync(path.join(dayDir, 'example.md'), 'utf8');
    assert.equal(content.includes('created:'), false);
    assert.equal(content.includes('accessed:'), false);
    assert.equal(content.includes('tier:'), false);
    // _meta.json created with migrated data
    const metaFile = path.join(dayDir, '_meta.json');
    assert.equal(fs.existsSync(metaFile), true);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.ok(meta['example.md']);
    assert.equal(meta['example.md'].tier, 'short');
  });

  test('is idempotent — second run does not re-import already migrated fields', async () => {
    const dayDir = path.join(projectRoot, '.claude', 'memory', '2026', '06', '10');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, 'example.md'),
      '---\nname: example\ndescription: an example memory\ncreated: 2026-06-10\naccessed: 2026-06-10\ntier: short\n---\n\nbody\n',
    );

    await migrate(projectRoot);
    // Second run: volatile fields already stripped, _meta.json already exists
    await migrate(projectRoot);

    // frontmatter should still be clean
    const content = fs.readFileSync(path.join(dayDir, 'example.md'), 'utf8');
    assert.equal(content.includes('created:'), false);
    assert.equal(content.includes('accessed:'), false);
    // _meta.json still intact
    const meta = JSON.parse(fs.readFileSync(path.join(dayDir, '_meta.json'), 'utf8'));
    assert.ok(meta['example.md']);
  });

  test('creates .gitignore even when .claude/ does not exist', async () => {
    const { changed, summary } = await migrate(projectRoot);
    // gitignore step runs regardless of .claude/ presence
    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('rem gitignore ignore')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.gitignore')), true);
  });

  test('removes stray legacy .claude/.retro_state.json', async () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.claude', '.retro_state.json'), '{}');

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('.retro_state.json')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', '.retro_state.json')), false);
  });

  // rem owns ONLY ignores for the artifacts it generates — the broader .claude
  // structure template is the root migrate skill's concern.
  const REM_IGNORES = ['**/.claude/rules/MEMORY.md', '**/_meta.json'];

  test('ensures rem generated-artifact ignores when .gitignore does not exist', async () => {
    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    const gitignorePath = path.join(projectRoot, '.gitignore');
    assert.equal(fs.existsSync(gitignorePath), true);
    const present = new Set(fs.readFileSync(gitignorePath, 'utf8').split('\n').map(l => l.trim()));
    for (const e of REM_IGNORES) assert.ok(present.has(e), `missing ${e}`);
    assert.ok(summary.some(s => s.includes('rem gitignore ignore')));
  });

  test('appends only missing rem ignores, preserves everything else', async () => {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    // Host project already has its own .claude structure rules + one of rem's ignores.
    fs.writeFileSync(gitignorePath, '**/.claude/**\n!**/.claude/memory/\n!**/.claude/memory/**\nnode_modules/\n**/_meta.json\n');

    const { changed } = await migrate(projectRoot);

    assert.equal(changed, true);
    const content = fs.readFileSync(gitignorePath, 'utf8');
    assert.ok(content.includes('node_modules/'));            // unrelated entry kept
    assert.ok(content.includes('**/.claude/**'));            // host's structure rules untouched
    assert.ok(content.includes('**/.claude/rules/MEMORY.md')); // the missing rem ignore added
    // rem never strips others — _meta.json kept, MEMORY.md appended after it.
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    assert.equal(lines[lines.length - 1], '**/.claude/rules/MEMORY.md');
  });

  test('gitignore step is idempotent — no-op when rem ignores already present', async () => {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    fs.writeFileSync(gitignorePath, '.DS_Store\n' + REM_IGNORES.join('\n') + '\n');

    const { changed } = await migrate(projectRoot);

    // No .claude/ dir → no stamp; rem ignores already present → gitignore no-op → full no-op.
    assert.equal(changed, false);
  });

  test('removes legacy .claude/tasks/ and .claude/memory/tasks/ across scopes', async () => {
    const taskArchive = path.join(projectRoot, '.claude', 'tasks', 'archive', '2026', '05');
    fs.mkdirSync(taskArchive, { recursive: true });
    fs.writeFileSync(path.join(taskArchive, '30.md'), 'x');
    const memTasks = path.join(projectRoot, '.claude', 'memory', 'tasks');
    fs.mkdirSync(memTasks, { recursive: true });
    fs.writeFileSync(path.join(memTasks, 'old.md'), 'x');

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('legacy task dir')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'tasks')), false);
    assert.equal(fs.existsSync(memTasks), false);
  });

  test('converts flat YYYY-MM-DD/ memory dirs to nested YYYY/MM/DD/', async () => {
    const memoryDir = path.join(projectRoot, '.claude', 'memory');
    const flatDir = path.join(memoryDir, '2026-06-03');
    fs.mkdirSync(flatDir, { recursive: true });
    fs.writeFileSync(
      path.join(flatDir, 'flat-entry.md'),
      '---\nname: flat-entry\ndescription: test\ncreated: 2026-06-03\naccessed: 2026-06-03\ntier: short\n---\n\nbody\n',
    );

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('migrated 1 flat memory directory')));
    // Old flat dir removed
    assert.equal(fs.existsSync(flatDir), false);
    // New nested dir exists with the file
    const nestedFile = path.join(memoryDir, '2026', '06', '03', 'flat-entry.md');
    assert.equal(fs.existsSync(nestedFile), true);
    const content = fs.readFileSync(nestedFile, 'utf8');
    assert.match(content, /name: flat-entry/);
  });
});
