// todo.test.mjs — one backlog, no duplicate mechanism, no checkboxes in memory.
//   - a task's open items are lines of its journal;
//   - with `.claude/rem.json` {"backlog": "issues"} the repo backlog is the issue tracker and
//     `todo` is a read-only view;
//   - otherwise one file per item in .claude/todo/, archived into memory when closed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';
import { renderIndex } from '../scripts/lib.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TODO = path.join(REM, 'scripts', 'todo.js');
const TASK = path.join(REM, 'scripts', 'task.js');
const todayPath = new Date().toISOString().slice(0, 10).replace(/-/g, '/');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-todo-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const cli = (script) => (root, ...args) => spawnSync(process.execPath, [script, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
const todo = cli(TODO);
const task = (root, ...args) => (grantIfUserVerb(root, args), cli(TASK)(root, ...args));
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const items = (root) => fs.existsSync(path.join(root, '.claude', 'todo'))
  ? fs.readdirSync(path.join(root, '.claude', 'todo')).filter(f => f.endsWith('.md')) : [];
function snapshot(root) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out[path.relative(root, f)] = fs.readFileSync(f, 'utf8');
    }
  })(root);
  return out;
}

describe('per-item files (no tracker)', () => {
  it('add writes ONE new file per item, never under .claude/memory/', () => {
    const root = repo();
    ok(todo(root, 'add', 'Fix login timeout', '--severity', 'HIGH', '--module', 'auth'));
    ok(todo(root, 'add', 'Fix login timeout'));
    const files = items(root);
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);
    const text = fs.readFileSync(path.join(root, '.claude', 'todo', files[0]), 'utf8');
    assert.match(text, /^status: open$/m);
    assert.match(text, /^kind: todo$/m);
    assert.deepEqual(fs.readdirSync(path.join(root, '.claude', 'memory')), []);
    const report = ok(todo(root)).stdout;
    assert.match(report, /\[HIGH\] Fix login timeout/);
    assert.doesNotMatch(report, /- \[ \]/);
  });

  it('close archives the item into memory, kept whole and hidden from the index', () => {
    const root = repo();
    ok(todo(root, 'add', 'Fix login timeout'));
    const [file] = items(root);
    const id = file.replace(/\.md$/, '');
    const before = fs.readFileSync(path.join(root, '.claude', 'todo', file), 'utf8');
    ok(todo(root, 'close', id, 'fixed in abc123'));
    assert.deepEqual(items(root), []);
    const archived = path.join(root, '.claude', 'memory', ...todayPath.split('/'), `todo-${id}.md`);
    const after = fs.readFileSync(archived, 'utf8');
    assert.match(after, /^status: closed$/m);
    assert.match(after, /fixed in abc123/);
    assert.ok(after.includes(before.split('---\n').pop().trim()), 'the item body is kept');
    assert.doesNotMatch(renderIndex(root), /todo-/);
    assert.doesNotMatch(ok(todo(root)).stdout, /Fix login timeout/);
  });

  it("a task's open items are its journal lines; todo shows them and points at task.js to close one", () => {
    const root = repo();
    ok(task(root, 'open', 'alpha', 'migrate'));
    ok(task(root, 'open-item', 'port the helper', '--task', 'alpha'));
    assert.match(ok(todo(root)).stdout, /alpha O1: port the helper/);
    const r = todo(root, 'close', 'O1');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task\.js close-item/);
  });
});

describe('closing never half-writes an archive', () => {
  it('an archive name already taken refuses the close and leaves the item untouched', () => {
    const root = repo();
    ok(todo(root, 'add', 'Fix login timeout'));
    const [file] = items(root);
    const id = file.replace(/\.md$/, '');
    const src = path.join(root, '.claude', 'todo', file);
    const before = fs.readFileSync(src, 'utf8');
    const dest = path.join(root, '.claude', 'memory', ...todayPath.split('/'), `todo-${id}.md`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'occupied');
    assert.equal(todo(root, 'close', id, 'x').status, 1);
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'occupied');
  });
});

describe('backlog: issues', () => {
  it('todo is a read-only view: add is refused, nothing is written', () => {
    const root = repo();
    fs.writeFileSync(path.join(root, '.claude', 'rem.json'), '{"backlog": "issues"}\n');
    ok(task(root, 'open', 'alpha', 'migrate'));
    ok(task(root, 'open-item', 'port the helper', '--task', 'alpha'));
    const before = snapshot(root);
    const add = todo(root, 'add', 'Fix login timeout');
    assert.equal(add.status, 1);
    assert.match(add.stderr, /issue tracker/);
    const report = ok(todo(root)).stdout;
    assert.match(report, /alpha O1: port the helper/);
    assert.match(report, /issue tracker/);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('adopting a legacy checkbox file', () => {
  it('writes one item file per OPEN item, citing its source; the legacy file stays byte-identical', () => {
    const root = repo();
    const manual = path.join(root, '.claude', 'memory', '2026', '06', '20', 'manual.md');
    fs.mkdirSync(path.dirname(manual), { recursive: true });
    fs.writeFileSync(manual, '---\nname: manual-2026-06-20\n---\n\n'
      + '- [ ] MANUAL-20260620-001 [HIGH] Fix the flaky gate (2026-06-20)\n      module: ci\n'
      + '- [x] MANUAL-20260620-002 [LOW] Done already (2026-06-20)\n');
    const review = path.join(root, '.claude', 'memory', '2026', '06', '21', 'sharp-review.md');
    fs.mkdirSync(path.dirname(review), { recursive: true });
    fs.writeFileSync(review, '---\nname: sharp-review\n---\n\n'
      + '### [SR-20260621-001] [MEDIUM] src/a.js — Leaks a handle\n- **Status:** OPEN\n\n'
      + '### [SR-20260621-002] [HIGH] src/b.js — Already fixed\n- **Status:** FIXED\n');
    const before = [manual, review].map(f => fs.readFileSync(f, 'utf8'));
    ok(todo(root, 'adopt', '.claude/memory/2026/06/20/manual.md', '.claude/memory/2026/06/21/sharp-review.md'));
    assert.deepEqual([manual, review].map(f => fs.readFileSync(f, 'utf8')), before);
    const texts = items(root).map(f => fs.readFileSync(path.join(root, '.claude', 'todo', f), 'utf8'));
    assert.equal(texts.length, 2);
    assert.ok(texts.some(t => /Fix the flaky gate/.test(t) && /^from: memory\/2026\/06\/20\/manual\.md#MANUAL-20260620-001$/m.test(t) && /^module: ci$/m.test(t)));
    assert.ok(texts.some(t => /Leaks a handle/.test(t) && /^file: src\/a\.js$/m.test(t) && /^severity: MEDIUM$/m.test(t)));
    ok(todo(root, 'adopt', '.claude/memory/2026/06/20/manual.md'));
    assert.equal(items(root).length, 2, 'adopting twice adds nothing');
  });

  it('--dry-run lists the open items it would adopt and writes nothing, even when the backlog is the tracker', () => {
    const root = repo();
    const manual = path.join(root, '.claude', 'memory', '2026', '06', '20', 'manual.md');
    fs.mkdirSync(path.dirname(manual), { recursive: true });
    fs.writeFileSync(manual, '- [ ] MANUAL-1 [HIGH] Fix the flaky gate (2026-06-20)\n- [x] MANUAL-2 [LOW] Done (2026-06-20)\n');
    fs.writeFileSync(path.join(root, '.claude', 'rem.json'), '{"backlog":"issues"}');
    const r = ok(todo(root, 'adopt', '--dry-run', '.claude/memory/2026/06/20/manual.md'));
    assert.match(r.stdout, /would adopt 1 open item/);
    assert.match(r.stdout, /memory\/2026\/06\/20\/manual\.md#MANUAL-1 \[HIGH\] Fix the flaky gate/);
    assert.equal(fs.existsSync(path.join(root, '.claude', 'todo')), false);
  });
});

describe('stale bound docs', () => {
  it('a drifted bound doc shows as a DOC- row, and the report writes no state', async () => {
    const { saveAnchor } = await import('../scripts/doc-freshness.js');
    const root = repo();
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '1');
    git('add', '-A'); git('commit', '-qm', 'c0');
    const base = git('rev-parse', '--short', 'HEAD').stdout.trim();
    fs.mkdirSync(path.join(root, '.claude', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'docs', 'arch.md'),
      ['---', 'name: arch', 'metadata:', '  doc_source: [src/]', '  stale_commits: 5', '---', '# arch'].join('\n'));
    saveAnchor(root, '.claude/docs/arch.md', { git_hash: base, reviewed_at: '2026-07-03' });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, 'src', 'a.js'), String(i + 2));
      git('add', '-A'); git('commit', '-qm', `c${i + 1}`);
    }
    const before = snapshot(root);
    assert.match(ok(todo(root)).stdout, /DOC-\.claude\/docs\/arch Refresh \.claude\/docs\/arch\.md — 6 commits drift/);
    assert.deepEqual(snapshot(root), before);
  });
});
