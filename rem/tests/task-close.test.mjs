// task-close.test.mjs — closing a task distills it first, then archives it into memory
// with git mv. An archived task has the memory architecture: one storage shape
// (memory/<date>/<name>, a directory), one frontmatter, derived visibility. Nothing is deleted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listEntries, renderIndex } from '../scripts/lib.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');
const RECALL = path.join(REM, 'scripts', 'recall.js');
const today = new Date().toISOString().slice(0, 10);
const todayPath = today.replace(/-/g, '/');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-close-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const task = (root, ...args) => spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function contents(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out.push(fs.readFileSync(f, 'utf8'));
    }
  })(dir);
  return out;
}
function worked(root) {
  ok(task(root, 'open', 'alpha', 'migrate the zebra store'));
  ok(task(root, 'decide', 'copy, never move, the zebra rows', '--task', 'alpha'));
  ok(task(root, 'decide', 'a scratch idea', '--task', 'alpha'));
  ok(task(root, 'open-item', 'measure the copy', '--task', 'alpha'));
}

describe('close distills first', () => {
  it('refuses while an open item is open or a decision is neither distilled nor kept in the journal', () => {
    const root = repo();
    worked(root);
    let r = task(root, 'close', 'alpha');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /O1 is open/);
    ok(task(root, 'close-item', 'O1', 'measured: 3.2 s', '--task', 'alpha'));
    r = task(root, 'close', 'alpha');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /D1, D2 not distilled/);
    put(root, '.claude/memory/2026/01/01/zebra-copy.md',
      '---\nname: zebra-copy\ndescription: rows are copied\nfrom: tasks/alpha/JOURNAL.md#D1\nmetadata:\n  type: project\n---\n\nwhy\n');
    r = task(root, 'close', 'alpha');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /D2 not distilled/);
    ok(task(root, 'close', 'alpha', '--journal-only', 'D2'));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'memory', ...todayPath.split('/'), 'task-alpha', 'JOURNAL.md')));
  });

  it('a decision cited by a rule or a doc counts as distilled', () => {
    const root = repo();
    worked(root);
    ok(task(root, 'close-item', 'O1', 'done', '--task', 'alpha'));
    put(root, '.claude/rules/zebra.md', '- Copy zebra rows (tasks/alpha/JOURNAL.md#D1).\n');
    put(root, 'docs/zebra.md', '---\nname: zebra\ndoc_source: [src/]\n---\n\nSee tasks/alpha/JOURNAL.md#D2.\n');
    ok(task(root, 'close', 'alpha'));
  });
});

describe('remember.js --from distills a decision', () => {
  it('writes from: and the cited decision counts as distilled', () => {
    const root = repo();
    worked(root);
    ok(task(root, 'close-item', 'O1', 'done', '--task', 'alpha'));
    const r = spawnSync(process.execPath, [path.join(REM, 'scripts', 'remember.js'), '--name', 'zebra-copy', '--type', 'project',
      '--body', 'Rows are copied because a move lost 3 rows.', '--task', 'alpha', '--from', 'tasks/alpha/JOURNAL.md#D1'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(r.stdout.trim(), 'utf8'), /^from:\n {2}- tasks\/alpha\/JOURNAL\.md#D1$/m);
    assert.match(ok(task(root, 'distill-status', 'alpha')).stdout, /undistilled: D2$/m);
  });
});

describe('close archives with git mv; nothing is lost', () => {
  it('moves the task under memory/<close-date>/task-<slug>/ as a rename, keeping every byte', () => {
    const root = repo();
    worked(root);
    ok(task(root, 'close-item', 'O1', 'done', '--task', 'alpha'));
    spawnSync('git', ['-C', root, 'add', '-A'], { env: { ...process.env, ...GIT_ENV } });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'open alpha'], { env: { ...process.env, ...GIT_ENV } });
    const before = contents(path.join(root, '.claude', 'tasks', 'alpha'));
    ok(task(root, 'close', 'alpha', 'shipped', '--journal-only', 'D1,D2'));
    const archived = path.join(root, '.claude', 'memory', ...todayPath.split('/'), 'task-alpha');
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'tasks', 'alpha')));
    const after = contents(archived);
    const journalBefore = before.find(t => t.includes('opened:'));
    assert.ok(after.some(t => t.startsWith(journalBefore)), 'the journal grew only by appends');
    assert.match(after.join('\n'), new RegExp(`^- ${today} closed: shipped \\(kept in the journal only: D1, D2\\)$`, 'm'));
    assert.match(after.join('\n'), /^status: closed$/m);
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
    assert.match(status, /^R. +\.claude\/tasks\/alpha\/JOURNAL\.md -> \.claude\/memory\/.*\/task-alpha\/JOURNAL\.md$/m);
  });
});

describe('an archived task has the memory architecture', () => {
  function archived() {
    const root = repo();
    worked(root);
    ok(task(root, 'close-item', 'O1', 'done', '--task', 'alpha'));
    put(root, '.claude/memory/2026/01/01/zebra-copy.md',
      '---\nname: zebra-copy\ndescription: zebra rows are copied\ntask: alpha\nfrom: tasks/alpha/JOURNAL.md#D1\nmetadata:\n  type: project\n---\n\nzebra copy reasons\n');
    ok(task(root, 'close', 'alpha', '--journal-only', 'D2'));
    return root;
  }

  it('is ONE entry: a directory, kind task, read from the same frontmatter', () => {
    const root = archived();
    const t = listEntries(root).find(e => e.kind === 'task');
    assert.equal(t.path, `${todayPath}/task-alpha`);
    assert.equal(t.task, 'alpha');
    assert.equal(t.name, 'alpha');
    assert.equal(t.description, 'migrate the zebra store');
    assert.equal(t.created, today);
    assert.ok(!listEntries(root).some(e => e.path.endsWith('JOURNAL.md') || e.path.endsWith('TASK.md')));
  });

  it('leaves the index and recall, while the entries distilled from it stay', () => {
    const root = archived();
    const index = renderIndex(root);
    assert.doesNotMatch(index, /task-alpha/);
    assert.match(index, /zebra-copy\.md/);
    const r = spawnSync(process.execPath, [RECALL], { input: JSON.stringify({ prompt: 'zebra copy', cwd: root }), encoding: 'utf8', cwd: root });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /zebra copy reasons/);
    assert.doesNotMatch(ctx, /Bound task/);
  });

  it('stays readable by provenance: task.js show finds the archived task', () => {
    const root = archived();
    const r = ok(task(root, 'show', 'alpha'));
    assert.match(r.stdout, /D1: copy, never move, the zebra rows/);
    assert.match(r.stdout, /status: closed/);
  });
});
