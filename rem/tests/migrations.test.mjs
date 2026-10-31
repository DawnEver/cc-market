/**
 * Tests for rem/migrations/migrate.mjs — one-shot move to the tree-only lifecycle.
 * Run: node --test cc-market/rem/tests/migrations.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrate, stripVolatile } from '../migrations/migrate.mjs';

let root;
const mem = (...p) => path.join(root, '.claude', 'memory', ...p);
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

function legacyProject() {
  put(mem('2026', '07', '01', 'old.md'), '---\nname: fact\ndescription: d\ncreated: 2026-07-01\naccessed: 2026-09-01\ntier: long\nmetadata:\n  type: project\n---\n\ntier: in the body stays\n');
  put(mem('2026', '08', '01', 'new.md'), '---\nname: fact\ndescription: d\nmerged_from: 2026/07/01/old.md\nmetadata:\n  type: project\n---\n\nnew\n');
  put(mem('2026', '07', '01', '_meta.json'), '{"old.md":{"accessed":"2026-09-01","count":4,"tier":"long"}}');
  put(path.join(root, '.claude', 'meta', 'MEMORY.full.md'), '# catalog\n');
  put(path.join(root, '.claude', '.rem-state.json'), JSON.stringify({ hook: { stopCount: 2 }, prune: { lastPruneAt: 5, events: [] } }));
}

describe('rem migrate()', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-migrate-'));
    fs.mkdirSync(path.join(root, '.git'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('stripVolatile touches only frontmatter and keeps created', () => {
    const out = stripVolatile('---\nname: a\ncreated: 2026-01-01\naccessed: 2026-02-02\ncount: 3\n---\n\ncount: body\n');
    assert.equal(out, '---\nname: a\ncreated: 2026-01-01\n---\n\ncount: body\n');
  });

  test('dry run reports every step and changes nothing', async () => {
    legacyProject();
    const before = fs.readFileSync(mem('2026', '07', '01', 'old.md'), 'utf8');
    const { counts, summary } = await migrate(root, { dryRun: true });
    assert.deepEqual(
      { meta: counts.meta, catalog: counts.catalog, stripped: counts.stripped, retired: counts.retired, state: counts.state },
      { meta: 1, catalog: 1, stripped: 1, retired: 1, state: 1 },
    );
    assert.ok(summary.every(s => /would|regenerated/.test(s)));
    assert.equal(fs.readFileSync(mem('2026', '07', '01', 'old.md'), 'utf8'), before);
    assert.ok(fs.existsSync(mem('2026', '07', '01', '_meta.json')));
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')));
  });

  test('applies: bookkeeping gone, superseded entry retired, index derived, then idempotent', async () => {
    legacyProject();
    await migrate(root);
    assert.ok(!fs.existsSync(mem('2026', '07', '01', '_meta.json')));
    assert.ok(!fs.existsSync(mem('2026', '07', '01', 'old.md')));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'meta', 'MEMORY.full.md')));
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.rem-state.json'), 'utf8'));
    assert.deepEqual(state, { hook: { stopCount: 2 } });
    const index = fs.readFileSync(path.join(root, '.claude', 'rules', 'MEMORY.md'), 'utf8');
    assert.match(index, /2026\/08\/01\/new\.md/);
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\*\*\/\.claude\/rules\/MEMORY\.md$/m);
    const again = await migrate(root);
    assert.equal(again.changed, false);
  });

  test('appends only missing ignores and preserves the rest', async () => {
    put(path.join(root, '.gitignore'), 'node_modules/\n**/.claude/memo/\n');
    await migrate(root);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n**/.claude/memo/\n\n**/.claude/rules/MEMORY.md\n');
  });
});
