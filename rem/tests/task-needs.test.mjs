// A task declares the test resources it needs (D79): `task.js open --needs a,b` writes `needs: [a, b]` into
// TASK.md's frontmatter -- the one shape dev-lab's dep door reads -- and the bound `task.js needs set` amends
// it, recording old and new as a decision (the journal stays append-only).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';
import { tasksDir, readTask, parseNeeds } from '../scripts/tasks.mjs';

const TASK = fileURLToPath(new URL('../scripts/task.js', import.meta.url));

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-needs-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const run = (root, ...args) => (grantIfUserVerb(root, args), spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } }));
const record = (root, slug) => fs.readFileSync(path.join(tasksDir(root), slug, 'TASK.md'), 'utf8');

describe('task needs', () => {
  it('open --needs writes the one frontmatter line dev-lab reads', () => {
    const root = repo();
    const r = run(root, 'open', 't', 'goal', '--needs', 'simba, windows');
    assert.equal(r.status, 0, r.stderr);
    assert.match(record(root, 't'), /^needs: \[simba, windows\]$/m);
    assert.deepEqual(readTask(root, 't').needs, ['simba', 'windows']);
  });

  it('PLANTED CONTROL: a task opened without --needs carries no needs line', () => {
    const root = repo();
    run(root, 'open', 't', 'goal');
    assert.doesNotMatch(record(root, 't'), /^needs:/m);
    assert.deepEqual(readTask(root, 't').needs, []);
  });

  it('a malformed need is refused by name and opens nothing', () => {
    const root = repo();
    const r = run(root, 'open', 't', 'goal', '--needs', 'Simba,ok');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs must be need names .*Simba/);
    assert.equal(fs.existsSync(path.join(tasksDir(root), 't')), false);
  });

  it('needs set rewrites the line and records old and new as a decision', () => {
    const root = repo();
    run(root, 'open', 't', 'goal', '--needs', 'simba');
    const r = run(root, 'needs', 'set', 'femm,simba', '--task', 't');
    assert.equal(r.status, 0, r.stderr);
    assert.match(record(root, 't'), /^needs: \[femm, simba\]$/m);
    assert.match(r.stdout, /D1: needs set to \[femm, simba\] \(was \[simba\]\)/);
  });

  it('needs set with an empty list removes the line', () => {
    const root = repo();
    run(root, 'open', 't', 'goal', '--needs', 'simba');
    run(root, 'needs', 'set', '', '--task', 't');
    assert.doesNotMatch(record(root, 't'), /^needs:/m);
  });

  it('PLANTED CONTROL: needs set refuses a malformed need and leaves the record and journal untouched', () => {
    const root = repo();
    run(root, 'open', 't', 'goal', '--needs', 'simba');
    const before = record(root, 't');
    const r = run(root, 'needs', 'set', 'bad name', '--task', 't');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs must be need names/);
    assert.equal(record(root, 't'), before);
    assert.equal(readTask(root, 't').decisions.length, 0);
  });

  it('parseNeeds dedupes and keeps order', () => {
    assert.deepEqual(parseNeeds('simba, femm, simba'), ['simba', 'femm']);
  });
});
