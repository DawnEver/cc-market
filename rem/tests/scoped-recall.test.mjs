// scoped-recall.test.mjs — recall is scoped: the bound task, entries of that task, the
// entries of the scope(s) being worked on, and the bound docs of those paths. Another
// task's memory comes in only when the prompt names that task.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const RECALL = path.join(REM, 'scripts', 'recall.js');
const TASK = path.join(REM, 'scripts', 'task.js');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-scoped-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const entry = (name, desc, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}metadata:\n  type: project\n---\n\nbody of ${name}\n`;
const task = (root, ...args) => {
  grantIfUserVerb(root, args);
  const r = spawnSync(process.execPath, [TASK, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
};
function recall(root, prompt) {
  const r = spawnSync(process.execPath, [RECALL], { input: JSON.stringify({ prompt, cwd: root }), encoding: 'utf8', cwd: root });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}
const branch = (root, name) => spawnSync('git', ['-C', root, 'checkout', '-q', '-b', name]);

describe('scoped recall', () => {
  it("never injects another task's entries into an unrelated task's turn", () => {
    const root = repo();
    task(root, 'open', 'alpha', 'migrate the zebra store');
    task(root, 'open', 'beta', 'tune the lion cache');
    put(root, '.claude/memory/2026/01/01/zebra-migration.md', entry('zebra-migration', 'zebra migration notes', 'task: alpha\n'));
    branch(root, 'pr/beta');
    assert.doesNotMatch(recall(root, 'zebra migration'), /body of zebra-migration/);
  });

  it('brings another task in when the prompt names it', () => {
    const root = repo();
    task(root, 'open', 'alpha', 'migrate the zebra store');
    task(root, 'open', 'beta', 'tune the lion cache');
    put(root, '.claude/memory/2026/01/01/zebra-migration.md', entry('zebra-migration', 'zebra migration notes', 'task: alpha\n'));
    branch(root, 'pr/beta');
    assert.match(recall(root, 'what did alpha decide about the zebra migration'), /body of zebra-migration/);
  });

  it("injects the bound task's goal, open items and latest journal lines on every turn", () => {
    const root = repo();
    task(root, 'open', 'beta', 'tune the lion cache');
    task(root, 'open-item', 'measure p95', '--task', 'beta');
    task(root, 'decide', 'keep the LRU', '--task', 'beta');
    branch(root, 'pr/beta');
    const ctx = recall(root, 'continue');
    assert.match(ctx, /Bound task: beta — tune the lion cache/);
    assert.match(ctx, /O1 open: measure p95/);
    assert.match(ctx, /D1: keep the LRU/);
  });

  it("ranks the bound task's own entry above an equally matching untagged one", () => {
    const root = repo();
    task(root, 'open', 'beta', 'tune the lion cache');
    put(root, '.claude/memory/2026/01/01/lion-cache-a.md', entry('lion-cache-a', 'lion cache sizing'));
    put(root, '.claude/memory/2026/01/01/lion-cache-b.md', entry('lion-cache-b', 'lion cache sizing', 'task: beta\n'));
    branch(root, 'pr/beta');
    const ctx = recall(root, 'lion cache sizing');
    assert.ok(ctx.indexOf('body of lion-cache-b') >= 0);
    assert.ok(ctx.indexOf('body of lion-cache-b') < ctx.indexOf('body of lion-cache-a'));
  });

  it('recalls the bound docs of the paths the task works on, not of other paths', () => {
    const root = repo();
    put(root, 'src/zebra/a.js', '');
    put(root, 'src/lion/b.js', '');
    put(root, 'docs/zebra-store.md', '---\nname: zebra-store\ndescription: how the zebra store works\ndoc_source: [src/zebra/]\n---\n\nzebra store mechanism\n');
    put(root, 'docs/lion-store.md', '---\nname: lion-store\ndescription: how the lion zebra store works\ndoc_source: [src/lion/]\n---\n\nlion store mechanism\n');
    assert.match(recall(root, 'zebra store'), /zebra store mechanism/);
    task(root, 'open', 'alpha', 'migrate the zebra store', '--scope', 'src/zebra');
    branch(root, 'pr/alpha');
    const ctx = recall(root, 'zebra store');
    assert.match(ctx, /zebra store mechanism/);
    assert.doesNotMatch(ctx, /lion store mechanism/);
  });

  it('recalls entries of the scope a task works in', () => {
    const root = repo();
    put(root, 'pkg/x.js', '');
    put(root, 'pkg/.claude/memory/2026/01/01/zebra-pkg.md', entry('zebra-pkg', 'zebra pkg notes'));
    assert.doesNotMatch(recall(root, 'zebra pkg'), /body of zebra-pkg/);
    task(root, 'open', 'alpha', 'zebra work', '--scope', 'pkg');
    branch(root, 'pr/alpha');
    assert.match(recall(root, 'zebra pkg'), /body of zebra-pkg/);
  });
});
