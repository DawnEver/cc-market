/**
 * Tests for rem/migrations/migrate.mjs — additive .gitignore upkeep; never touches memory.
 * Run: node --test cc-market/rem/tests/migrations.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
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

describe('rem migration plan (four layers)', () => {
  let root;
  const { spawnSync } = childProcess;
  const write = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const snapshot = () => Object.fromEntries(walk(root).map(f => [f, fs.readFileSync(f, 'utf8')]));
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-plan-'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    write('.claude/memory/2026/10/01/an-entry.md', '---\nname: an-entry\ndescription: d\naccessed: 2026-10-28\ntier: hot\ncount: 3\ncreated: 2026-10-01\n---\n\naccessed: body text stays\n');
    write('.claude/memory/2026/10/02/manual-tasks.md', '---\nname: manual\n---\n\n- [ ] M-1 [HIGH] Open one (2026-10-02)\n- [x] M-2 [LOW] Closed one (2026-10-02)\n');
    write('.claude/memory/2026/10/03/HANDOFF-x.md', '---\nname: h\n---\nb\n');
    write('.claude/memory/2026/10/03/PLAN-y.md', '---\nname: p\n---\nb\n');
    write('src/.claude/memory/2026/10/04/DECISIONS-z.md', '---\nname: z\naccessed: 2026-10-04\n---\nb\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('a dry run plans the strip, the adoption and the classes, and writes nothing', async () => {
    const before = snapshot();
    const { plan } = await migrate(root, { dryRun: true });
    assert.deepEqual(snapshot(), before, 'a dry run writes nothing');
    assert.deepEqual(plan.strip.map(s => [s.path, s.fields]), [
      ['.claude/memory/2026/10/01/an-entry.md', ['accessed', 'tier', 'count']],
      ['src/.claude/memory/2026/10/04/DECISIONS-z.md', ['accessed']],
    ]);
    assert.deepEqual(plan.legacyTodos, [{ path: '.claude/memory/2026/10/02/manual-tasks.md', open: 1, closed: 1 }]);
    assert.deepEqual(plan.classified.map(c => [c.path, c.prefix]), [
      ['.claude/memory/2026/10/03/HANDOFF-x.md', 'HANDOFF'],
      ['.claude/memory/2026/10/03/PLAN-y.md', 'PLAN'],
      ['src/.claude/memory/2026/10/04/DECISIONS-z.md', 'DECISIONS'],
    ]);
    assert.deepEqual(plan.deletes, []);
  });

  test('applying strips only frontmatter volatile fields and deletes nothing', async () => {
    const files = Object.keys(snapshot());
    await migrate(root);
    const after = snapshot();
    assert.deepEqual(Object.keys(after).filter(f => !f.endsWith('.gitignore')), files.filter(f => !f.endsWith('.gitignore')));
    const entry = after[path.join(root, '.claude/memory/2026/10/01/an-entry.md')];
    assert.doesNotMatch(entry.split('---')[1], /^(accessed|tier|count):/m);
    assert.match(entry, /^created: 2026-10-01$/m);
    assert.match(entry, /accessed: body text stays/);
  });

  test('the closing fence is a whole `---` line: `----` and `---x` do not end the frontmatter', async () => {
    const rel = '.claude/memory/2026/10/05/fences.md';
    write(rel, '---\nname: f\ndescription: d\n----\n---x\naccessed: 2026-10-05\n---\n\n---x body\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    const { plan } = await migrate(root, { dryRun: true });
    assert.deepEqual(plan.strip.find(s => s.path === rel)?.fields, ['accessed']);
    await migrate(root);
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), '---\nname: f\ndescription: d\n----\n---x\n---\n\n---x body\n');
  });
});
