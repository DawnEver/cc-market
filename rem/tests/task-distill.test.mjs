// task-distill.test.mjs — a task that never closes stays small: `task.js distill` moves old journal lines
// verbatim into chapters/<date>.md (mechanical, deterministic), and `distill --plan` applies an agent's
// judgment of which decisions are captured elsewhere. Every Dn keeps its id and stays findable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-distill-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const task = (root, ...args) => (grantIfUserVerb(root, args), spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } }));
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const dir = root => path.join(root, '.claude', 'tasks', 'alpha');
const journal = root => fs.readFileSync(path.join(dir(root), 'JOURNAL.md'), 'utf8');

// An open task whose journal holds old lines (2026-01-0x) and today's.
function aged(root) {
  ok(task(root, 'open', 'alpha', 'migrate the zebra store'));
  const old = ['- 2026-01-01 D1: copy the zebra rows', '- 2026-01-01 progress: copied half',
    '- 2026-01-02 D2: keep the old index', '- 2026-01-02 O1 open: measure the copy',
    '- 2026-01-02 O2 open: retire the index', '- 2026-01-03 O2 closed: retired', '- 2026-01-03 D3: one writer only'];
  const file = path.join(dir(root), 'JOURNAL.md');
  const text = fs.readFileSync(file, 'utf8').replace(/\n?$/, '\n');
  fs.writeFileSync(file, text + old.join('\n') + '\n');
  ok(task(root, 'decide', 'a fresh decision', '--task', 'alpha'));
}

describe('mechanical distill', () => {
  it('moves old lines verbatim into dated chapters and keeps ids, open items and the newest decisions', () => {
    const root = repo();
    aged(root);
    ok(task(root, 'distill', '--task', 'alpha', '--keep', '1', '--before', '2026-02-01'));
    const live = journal(root);
    assert.match(live, / opened: /);
    assert.match(live, /O1 open: measure the copy/, 'a still-open item stays live');
    assert.match(live, /D4: a fresh decision/);
    assert.doesNotMatch(live, /D1:|D2:|D3:|O2 /);
    const ch = path.join(dir(root), 'chapters');
    assert.match(fs.readFileSync(path.join(ch, '2026-01-01.md'), 'utf8'), /^- 2026-01-01 D1: copy the zebra rows$/m);
    assert.match(fs.readFileSync(path.join(ch, '2026-01-03.md'), 'utf8'), /O2 closed: retired/);
    // Numbering reads the chapters: the next decision is D5, never a second D1.
    ok(task(root, 'decide', 'after the distill', '--task', 'alpha'));
    assert.match(journal(root), /D5: after the distill/);
    // An archived decision is still found by id.
    const r = ok(task(root, 'status', 'D2', '--task', 'alpha'));
    assert.match(r.stdout, /D2: keep the old index/);
    assert.match(r.stdout, /chapters[\\/]2026-01-02\.md/);
  });

  it('keeps every line when nothing is older than the window (planted control)', () => {
    const root = repo();
    aged(root);
    const before = journal(root);
    ok(task(root, 'distill', '--task', 'alpha', '--before', '2025-01-01'));
    assert.equal(journal(root), before);
    assert.equal(fs.existsSync(path.join(dir(root), 'chapters')), false);
  });

  it('status stays within 2 KB and shows the newest n decisions', () => {
    const root = repo();
    aged(root);
    const r = ok(task(root, 'status', 'alpha', '--decisions', '2'));
    assert.ok(Buffer.byteLength(r.stdout) <= 2048 + 1);
    assert.match(r.stdout, /D3 /);
    assert.doesNotMatch(r.stdout, /D2 /);
  });
});

describe('plan distill', () => {
  const plan = (root, body) => { const f = path.join(root, 'plan.json'); fs.writeFileSync(f, JSON.stringify(body)); return f; };

  it('moves only the planned decisions, with their pointers, and they count as distilled', () => {
    const root = repo();
    aged(root);
    ok(task(root, 'distill', '--task', 'alpha', '--plan', plan(root, { distill: [{ id: 'D1', pointer: 'RULE-ZEBRA-COPY' }] })));
    const distilled = fs.readFileSync(path.join(dir(root), 'chapters', 'distilled.md'), 'utf8');
    assert.match(distilled, /D1: copy the zebra rows\n {2}-> RULE-ZEBRA-COPY/);
    assert.doesNotMatch(distilled, /D2|D3|D4/, 'a decision the plan does not name is never distilled');
    assert.match(journal(root), /D2: keep the old index/);
    assert.match(journal(root), /progress: distilled D1 by plan/);
    const s = ok(task(root, 'status', 'D1', '--task', 'alpha'));
    assert.match(s.stdout, /-> RULE-ZEBRA-COPY/);
    const u = ok(task(root, 'status', 'alpha', '--distill'));
    assert.match(u.stdout, /undistilled: D2, D3, D4/);
  });

  it('refuses a plan naming an unknown decision, by name, and changes nothing', () => {
    const root = repo();
    aged(root);
    const before = journal(root);
    const r = task(root, 'distill', '--task', 'alpha', '--plan',
      plan(root, { distill: [{ id: 'D1', pointer: 'x' }, { id: 'D99', pointer: 'y' }] }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /D99, which is no decision of alpha/);
    assert.equal(journal(root), before);
    assert.equal(fs.existsSync(path.join(dir(root), 'chapters')), false);
  });

  it('refuses a row without a pointer', () => {
    const root = repo();
    aged(root);
    const r = task(root, 'distill', '--task', 'alpha', '--plan', plan(root, { distill: [{ id: 'D1' }] }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /D1 needs a one-line pointer/);
  });
});
