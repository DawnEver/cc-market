// The exceptional case (user ruling 2026-11-13): a journal line that is WRONG -- a misstated fact, a
// mistranslated quote -- is corrected in place, only with a reason and the user's words approving it,
// and the journal records the amendment on a new line.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';
import { tasksDir } from '../scripts/tasks.mjs';
import { decideTaskGuard } from '../hooks/task-guard.js';

const TASK = fileURLToPath(new URL('../scripts/task.js', import.meta.url));
const today = new Date().toISOString().slice(0, 10);

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-amend-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const run = (root, ...args) => (grantIfUserVerb(root, args), spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } }));
const file = (root, slug) => path.join(tasksDir(root), slug, 'JOURNAL.md');
const lines = (root, slug) => fs.readFileSync(file(root, slug), 'utf8').split('\n');
const lineOfD1 = root => lines(root, 't').findIndex(l => / D1: /.test(l)) + 1;

function wrongJournal() {
  const root = repo();
  run(root, 'open', 't', 'goal');
  run(root, 'decide', 'the user said: decide it NOT yourself', '--task', 't');
  return root;
}

describe('amend', () => {
  it('replaces one line in place and records the reason, the approval and the old line digest', () => {
    const root = wrongJournal();
    const before = lines(root, 't');
    const n = lineOfD1(root);
    const old = before[n - 1];
    const fixed = old.replace('decide it NOT yourself', 'decide it yourself');
    const r = run(root, 'amend', '--line', String(n), fixed,
      '--reason', 'the quote was mistranslated', '--approved', 'fix that line', '--task', 't');
    assert.equal(r.status, 0, r.stderr);
    const after = lines(root, 't');
    assert.equal(after[n - 1], fixed);
    const digest = createHash('sha256').update(old).digest('hex').slice(0, 12);
    const audit = `- ${today} progress: line ${n} amended: the quote was mistranslated -- approved: "fix that line" (was sha256:${digest})`;
    assert.equal(after.filter(Boolean).at(-1), audit);
    assert.equal(after.filter(Boolean).length, before.filter(Boolean).length + 1);
  });

  for (const [why, extra] of [
    ['no reason', ['--approved', 'fix it']],
    ['no approval', ['--reason', 'wrong']],
    ['an empty approval', ['--reason', 'wrong', '--approved', ' ']],
  ]) {
    it(`PLANTED: refuses ${why} and leaves the journal byte-identical`, () => {
      const root = wrongJournal();
      const before = fs.readFileSync(file(root, 't'));
      const n = lineOfD1(root);
      const fixed = lines(root, 't')[n - 1].replace('NOT ', '');
      assert.equal(run(root, 'amend', '--line', String(n), fixed, ...extra, '--task', 't').status, 1);
      assert.deepEqual(fs.readFileSync(file(root, 't')), before);
    });
  }

  it('PLANTED: refuses a non-entry line, an out-of-range line, a moved prefix and a multi-line text', () => {
    const root = wrongJournal();
    const ok = ['--reason', 'r', '--approved', 'a', '--task', 't'];
    const n = lineOfD1(root);
    assert.equal(run(root, 'amend', '--line', '1', 'x', ...ok).status, 1);
    assert.equal(run(root, 'amend', '--line', '999', 'x', ...ok).status, 1);
    assert.equal(run(root, 'amend', '--line', String(n), '- 2000-01-01 D1: moved the prefix', ...ok).status, 1);
    assert.equal(run(root, 'amend', '--line', String(n), 'a\nb', ...ok).status, 1);
  });

  it('is an ordinary journal verb to the guard, while open and close stay the user\'s', () => {
    const cmd = c => decideTaskGuard({ tool_name: 'Bash', tool_input: { command: c } }).deny;
    assert.equal(cmd('node rem/scripts/task.js amend --line 3 "x" --reason r --approved a'), false);
    assert.equal(cmd('node rem/scripts/task.js close t'), true);
  });
});
