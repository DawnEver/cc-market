/**
 * Tests for rem/migrations/migrate.mjs — additive .gitignore upkeep; never touches memory.
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

  test('creates .gitignore even when .claude/ does not exist', async () => {
    const { changed, summary } = await migrate(projectRoot);
    // gitignore step runs regardless of .claude/ presence
    assert.equal(changed, true);
    assert.ok(summary.some(s => s.includes('rem gitignore ignore')));
    assert.equal(fs.existsSync(path.join(projectRoot, '.gitignore')), true);
  });

  // rem owns ONLY ignores for the artefacts it generates — the broader .claude
  // structure template is the root migrate skill's concern.
  const REM_IGNORES = ['**/.claude/memory-index.md', '**/.claude/rules/MEMORY.md', '**/_meta.json', '**/.claude/memo/'];

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
    // rem never strips others — _meta.json kept, missing entries appended after it
    // in REM_GENERATED_IGNORES order.
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    assert.deepEqual(lines.slice(-3), ['**/.claude/memory-index.md', '**/.claude/rules/MEMORY.md', '**/.claude/memo/']);
  });

  test('gitignore step is idempotent — no-op when rem ignores already present', async () => {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    fs.writeFileSync(gitignorePath, '.DS_Store\n' + REM_IGNORES.join('\n') + '\n');

    const { changed } = await migrate(projectRoot);

    // No .claude/ dir → no stamp; rem ignores already present → gitignore no-op → full no-op.
    assert.equal(changed, false);
  });


  test('never touches .claude/: memory, tasks and state files stay byte-identical', async () => {
    const files = {
      '.claude/memory/2026/01/01/a.md': '---\nname: a\n---\nbody\n',
      '.claude/memory/2026/01/01/_meta.json': '{}',
      '.claude/tasks/t/TASK.md': '---\nopened_by: user\n---\n',
      '.claude/.retro_state.json': '{}',
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, rel), text);
    }
    await migrate(projectRoot);
    for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(projectRoot, rel), 'utf8'), text, rel);
  });
});
