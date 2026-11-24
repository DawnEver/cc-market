/**
 * Tests for sharp-review/migrations/migrate.mjs — consolidate legacy
 * per-finding review files into the current single-file-per-day format.
 * Run: node --test cc-market/sharp-review/tests/migrations.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrate } from '../migrations/migrate.mjs';
import { tempDir } from '../../tests/temp-dir.mjs';

describe('sharp-review migrate()', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = tempDir('sr-migrate-');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeFlatDay(date, files, resolved) {
    const dir = path.join(projectRoot, '.claude', 'memory', date);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    if (resolved) fs.writeFileSync(path.join(dir, 'resolved.txt'), resolved);
    return dir;
  }

  test('consolidates per-finding files into a single sharp-review.md', async () => {
    writeFlatDay('2026-06-04', {
      'SR-20260604-001.md': '### [SR-20260604-001] [HIGH] foo.js — some bug\n- **Module:** foo\nDetails for 001.',
      'SR-20260604-002.md': '### [SR-20260604-002] [LOW] bar.js — minor nit\n- **Module:** bar\nDetails for 002.',
    }, 'SR-20260604-002\n');

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, true);
    assert.equal(summary.length, 1);

    const target = path.join(projectRoot, '.claude', 'memory', '2026', '06', '04', 'sharp-review.md');
    assert.ok(fs.existsSync(target));
    const content = fs.readFileSync(target, 'utf8');

    assert.match(content, /^---\nname: sharp-review-2026-06-04/);
    assert.match(content, /\[SR-20260604-001\][\s\S]*?- \*\*Status:\*\* OPEN/);
    assert.match(content, /\[SR-20260604-002\][\s\S]*?- \*\*Status:\*\* FIXED/);

    // Old flat dir fully cleaned up
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'memory', '2026-06-04')), false);
  });

  test('is a no-op once a project is current', async () => {
    writeFlatDay('2026-06-04', {
      'SR-20260604-001.md': '### [SR-20260604-001] [HIGH] foo.js — some bug\n- **Module:** foo\nDetails.',
    });

    await migrate(projectRoot);
    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, false);
    assert.deepEqual(summary, []);
  });

  test('leaves already-current nested-date dirs alone', async () => {
    const dir = path.join(projectRoot, '.claude', 'memory', '2026', '06', '09');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sharp-review.md'), '---\nname: sharp-review-2026-06-09\n---\n');

    const { changed, summary } = await migrate(projectRoot);

    assert.equal(changed, false);
    assert.deepEqual(summary, []);
  });

  test('returns no-op when .claude/memory does not exist', async () => {
    const { changed, summary } = await migrate(projectRoot);
    assert.equal(changed, false);
    assert.deepEqual(summary, []);
  });

  // ── Retired Stop hook: its trigger keys leave the tracked config; rem's state file is never touched ──

  const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf8'));

  test('never reads or writes the retired rem state file', async () => {
    const dir = path.join(projectRoot, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const planted = JSON.stringify({ reviewGate: { profileWeights: { diff: 0.9 }, wave: 2 } });
    fs.writeFileSync(path.join(dir, '.rem-state.json'), planted, 'utf8');
    const { changed } = await migrate(projectRoot);
    assert.equal(changed, false);
    assert.equal(fs.readFileSync(path.join(dir, '.rem-state.json'), 'utf8'), planted);
    assert.ok(!fs.existsSync(path.join(dir, 'sharp-review.json')), 'nothing relocated from rem');
  });

  test('drops the retired Stop-hook keys from the tracked config and keeps every live one', async () => {
    const cfgDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'sharp-review.json'), JSON.stringify({
      stopHook: false, thresholds: { wave0: { lines: 1, files: 1 } }, docsThreshold: 3, codebaseIntervalMin: 60,
      providers: { interactive: ['codex'] }, inlineDiffLimit: 100,
    }), 'utf8');

    const { changed, summary } = await migrate(projectRoot);
    assert.equal(changed, true);
    assert.match(summary.join('\n'), /dropped retired Stop-hook config/);
    assert.deepEqual(readJSON('.claude/sharp-review.json'), { providers: { interactive: ['codex'] }, inlineDiffLimit: 100 });
    assert.equal((await migrate(projectRoot)).changed, false, 'a current config is left alone');
  });

});
