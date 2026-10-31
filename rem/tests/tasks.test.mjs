// tasks.test.mjs — the tasks layer: an agent opening or closing a task is refused, a session
// binds to one task, and its JOURNAL.md is append-only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { grantIfUserVerb } from './user-grant.mjs';
import { readTask, listTasks, resolveTask, tasksDir } from '../scripts/tasks.mjs';
import { decideTaskGuard } from '../hooks/task-guard.js';

const REM = fileURLToPath(new URL('..', import.meta.url));
const TASK = path.join(REM, 'scripts', 'task.js');
const GUARD = path.join(REM, 'hooks', 'task-guard.js');
const today = new Date().toISOString().slice(0, 10);

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-task-'));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  return root;
}
const run = (root, ...args) => (grantIfUserVerb(root, args), spawnSync(process.execPath, [TASK, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } }));
const journal = (root, slug) => fs.readFileSync(path.join(tasksDir(root), slug, 'JOURNAL.md'), 'utf8');

describe('open', () => {
  it('writes TASK.md opened by the user and a JOURNAL.md, and refuses a second open', () => {
    const root = repo();
    const r = run(root, 'open', 'integrator', 'merge every lane into integrate/main', '--scope', 'src,docs');
    assert.equal(r.status, 0, r.stderr);
    const t = readTask(root, 'integrator');
    assert.equal(t.status, 'open');
    assert.equal(t.opened_by, 'user');
    assert.equal(t.goal, 'merge every lane into integrate/main');
    assert.deepEqual(t.scope, ['src', 'docs']);
    assert.equal(t.created, today);
    assert.match(journal(root, 'integrator'), new RegExp(`^- ${today} opened: merge every lane`, 'm'));
    assert.equal(run(root, 'open', 'integrator', 'again').status, 1);
    assert.equal(run(root, 'open', 'Bad_Slug', 'x').status, 1);
  });
});

describe('journal', () => {
  it('is append-only: every write keeps the previous bytes as a prefix; decisions and open items number themselves', () => {
    const root = repo();
    run(root, 'open', 't', 'goal');
    let before = journal(root, 't');
    const steps = [
      ['log', 'started the merge', '--task', 't'],
      ['decide', 'take the newer structure', '--task', 't'],
      ['decide', 'keep both options', '--task', 't'],
      ['open-item', 'port the helper', '--task', 't'],
      ['close-item', 'O1', 'ported in abc123', '--task', 't'],
      ['handoff', 'next: rerun the gate', '--task', 't'],
    ];
    for (const s of steps) {
      const r = run(root, ...s);
      assert.equal(r.status, 0, r.stderr);
      const now = journal(root, 't');
      assert.ok(now.startsWith(before), `${s[0]} rewrote the journal`);
      before = now;
    }
    assert.match(before, /^- \S+ D1: take the newer structure$/m);
    assert.match(before, /^- \S+ D2: keep both options$/m);
    assert.match(before, /^- \S+ O1 open: port the helper$/m);
    assert.match(before, /^- \S+ O1 closed: ported in abc123$/m);
    assert.match(before, /^- \S+ handoff: next: rerun the gate$/m);
    assert.deepEqual(readTask(root, 't').openItems, []);
  });

  it('refuses to write without a bound task, and never to a closed one', () => {
    const root = repo();
    assert.equal(run(root, 'log', 'orphan').status, 1);
    run(root, 'open', 'done', 'g');
    run(root, 'close', 'done');
    assert.equal(run(root, 'log', 'late', '--task', 'done').status, 1);
  });
});

describe('binding', () => {
  it('an explicit task wins; else the worktree or branch names it; a closed or unknown task binds nothing', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    run(root, 'open', 'other', 'g');
    assert.equal(resolveTask(root, { task: 'other' }), 'other');
    assert.equal(resolveTask(root, {}), null);
    spawnSync('git', ['-C', root, 'checkout', '-q', '-b', 'pr/feature-x']);
    assert.equal(resolveTask(root, {}), 'feature-x');
    const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`, 'other');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    spawnSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'x'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'scratch', wt]);
    fs.cpSync(path.join(root, '.claude'), path.join(wt, '.claude'), { recursive: true });
    assert.equal(resolveTask(wt, {}), 'other');
    run(root, 'close', 'feature-x');
    assert.equal(resolveTask(root, {}), null);
    assert.equal(resolveTask(root, { task: 'nope' }), null);
    assert.deepEqual(listTasks(root).map(t => `${t.slug}:${t.status}`), ['other:open'], 'a closed task is archived out of .claude/tasks/');
  });

  it('remember.js tags the entry with the bound task', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    const r = spawnSync(process.execPath, [path.join(REM, 'scripts', 'remember.js'),
      '--name', 'a-fact', '--type', 'project', '--body', 'b', '--task', 'feature-x'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(r.stdout.trim(), 'utf8'), /^task: feature-x$/m);
  });
});

describe('an agent opening a task is refused', () => {
  const deny = (payload) => decideTaskGuard(payload).deny;
  const write = (tool, file) => ({ tool_name: tool, tool_input: { file_path: file } });
  const bash = (command, tool = 'Bash') => ({ tool_name: tool, tool_input: { command } });

  it('refuses an agent writing TASK.md or rewriting JOURNAL.md, and running open/close', () => {
    assert.ok(deny(write('Write', '/r/.claude/tasks/x/TASK.md')));
    assert.ok(deny(write('Edit', 'C:\\r\\.claude\\tasks\\x\\TASK.md')));
    assert.ok(deny(write('MultiEdit', '/r/.claude/tasks/x/JOURNAL.md')));
    assert.ok(deny(write('Write', '/r/.claude/tasks/x/JOURNAL.md')));
    assert.ok(deny(bash('node "/p/rem/scripts/task.js" open x "goal"')));
    assert.ok(deny(bash('node task.js close x')));
    assert.ok(deny(bash('echo hi > .claude/tasks/x/TASK.md')));
    assert.ok(deny(bash('Set-Content .claude\\tasks\\x\\TASK.md hi', 'PowerShell')));
  });

  it('lets an agent read tasks and append to its journal through task.js', () => {
    assert.ok(!deny(write('Write', '/r/src/TASK.md')));
    assert.ok(!deny(write('Write', '/r/.claude/memory/2026/01/01/a.md')));
    assert.ok(!deny({ tool_name: 'Read', tool_input: { file_path: '/r/.claude/tasks/x/TASK.md' } }));
    assert.ok(!deny(bash('node task.js log "merged lane 3" --task x')));
    assert.ok(!deny(bash('cat .claude/tasks/x/TASK.md')));
  });

  it('planted control: the hook is wired, and a planted agent write is refused end to end', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(REM, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const group = (hooks.PreToolUse || []).find(g => g.hooks.some(h => h.command.includes('task-guard.js')));
    assert.ok(group, 'task-guard.js is not registered as a PreToolUse hook');
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell']) assert.match(tool, new RegExp(`^(?:${group.matcher})$`));
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(write('Write', '/r/.claude/tasks/x/TASK.md')), encoding: 'utf8' });
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /the user's \/rem:task open\|close command/);
    const ok = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(write('Write', '/r/src/a.js')), encoding: 'utf8' });
    assert.equal(ok.stdout, '');
  });

  it('the /rem:task command is user-only and runs task.js', () => {
    const text = fs.readFileSync(path.join(REM, 'commands', 'task.md'), 'utf8');
    assert.match(text, /^disable-model-invocation: true$/m);
    assert.match(text, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/task\.js" \$ARGUMENTS`/);
  });
});
