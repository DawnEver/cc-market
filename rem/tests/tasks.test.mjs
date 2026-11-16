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
import { readTask, listTasks, resolveTask, parseBindingStatus, tasksDir, commitRecord } from '../scripts/tasks.mjs';
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
  const bindTo = (slug, authority) => () => ({ slug, authority });
  const authorityOf = (root, slug) => readTask(root, slug).authority;
  const commit = root => spawnSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'x'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const worktree = (root, name, branch) => {
    const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`, name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, wt]);
    return wt;
  };

  it('an explicit task wins; else the user\'s session binding names it; else nothing', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    run(root, 'open', 'other', 'g');
    const bound = bindTo('feature-x', authorityOf(root, 'feature-x'));
    assert.equal(resolveTask(root, { task: 'other', binding: bound }), 'other');
    assert.equal(resolveTask(root, { binding: () => null }), null);
    assert.equal(resolveTask(root, { binding: bound }), 'feature-x');
    assert.equal(resolveTask(root, { task: 'nope' }), null);
  });

  it('a bound session resolves its task in any worktree and on any branch', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    commit(root);
    const wt = worktree(root, 'unrelated-name', 'lane/whatever');
    assert.equal(resolveTask(wt, { binding: bindTo('feature-x', authorityOf(root, 'feature-x')) }), 'feature-x',
      'the task is read under the main checkout, not the worktree');
  });

  it('a worktree or branch named after a task binds nothing without the user\'s binding', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    commit(root);
    spawnSync('git', ['-C', root, 'checkout', '-q', '-b', 'pr/feature-x']);
    assert.equal(resolveTask(root, { binding: () => null }), null);
    const wt = worktree(root, 'feature-x', 'feature-x');
    fs.cpSync(path.join(root, '.claude'), path.join(wt, '.claude'), { recursive: true });
    assert.equal(resolveTask(wt, { binding: () => null }), null);
    assert.equal(resolveTask(wt, {}), null, 'without a dev-lab python the binding is unread, never guessed');
  });

  it('a binding to a closed task, or under another authority, resolves nothing', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    const authority = authorityOf(root, 'feature-x');
    assert.ok(authority);
    assert.equal(resolveTask(root, { binding: bindTo('feature-x', 'forged') }), null);
    run(root, 'close', 'feature-x');
    assert.equal(resolveTask(root, { binding: bindTo('feature-x', authority) }), null);
    assert.deepEqual(listTasks(root), [], 'a closed task is archived out of .claude/tasks/');
  });

  it('reads dev-lab\'s status line, and nothing else, as a binding', () => {
    assert.deepEqual(parseBindingStatus('task feature-x@abc123\n'), { slug: 'feature-x', authority: 'abc123' });
    assert.equal(parseBindingStatus('no task bound: the user binds ...'), null);
    assert.equal(parseBindingStatus(''), null);
    assert.equal(parseBindingStatus('task Bad_Slug@x'), null);
    assert.equal(parseBindingStatus('task feature-x'), null);
  });

  it('task.js bound names the door when nothing is bound', () => {
    const r = run(repo(), 'bound');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no task bound/);
    assert.match(r.stdout, /`task: <slug>`/);
  });

  it('task.js open tells the user how to bind and name branches', () => {
    const r = run(repo(), 'open', 'feature-x', 'g');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /first line is `task: feature-x`/);
    assert.match(r.stdout, /pr\/feature-x\/<feature>/);
    assert.match(r.stdout, /never a bare pr\/feature-x/);
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

describe('place (cc-market #18)', () => {
  function withWorktree() {
    const main = repo();
    spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const wt = path.join(main, '.claude', 'worktrees', 'lane');
    spawnSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'lane', wt]);
    fs.mkdirSync(path.join(wt, '.claude', 'memory'), { recursive: true });
    return { main, wt };
  }

  it('copies an open task of a worktree into the main checkout, once, byte for byte', () => {
    const { main, wt } = withWorktree();
    assert.equal(run(wt, 'open', 'toolchain', 'finish the toolchain').status, 0);
    assert.equal(readTask(main, 'toolchain'), null);
    const r = run(wt, 'place', 'toolchain');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['TASK.md', 'JOURNAL.md']) {
      assert.equal(fs.readFileSync(path.join(tasksDir(main), 'toolchain', f), 'utf8'),
        fs.readFileSync(path.join(tasksDir(wt), 'toolchain', f), 'utf8'));
    }
    assert.equal(readTask(main, 'toolchain').status, 'open');
    assert.match(run(wt, 'place', 'toolchain').stdout, /already placed/);
  });

  it('PLANTED CONTROL: never overwrites a differing copy and never opens a task that is not open', () => {
    const { main, wt } = withWorktree();
    run(wt, 'open', 'toolchain', 'finish the toolchain');
    fs.mkdirSync(path.join(tasksDir(main), 'toolchain'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir(main), 'toolchain', 'TASK.md'), 'a different record\n');
    const clash = run(wt, 'place', 'toolchain');
    assert.equal(clash.status, 1);
    assert.match(clash.stderr, /different TASK\.md .* never overwritten/);
    assert.equal(fs.readFileSync(path.join(tasksDir(main), 'toolchain', 'TASK.md'), 'utf8'), 'a different record\n');
    const none = run(wt, 'place', 'nothing-open');
    assert.equal(none.status, 1);
    assert.match(none.stderr, /never opens one/);
  });

  it('the task guard lets an agent run task.js place', () => {
    assert.equal(decideTaskGuard({ tool_name: 'Bash', tool_input: { command: `node ${TASK} place toolchain` } }).deny, false);
  });
});

describe('commit-record: the bound session takes the main checkout\'s record into its worktree', () => {
  function opened() {
    const main = repo();
    spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const wt = path.join(main, '.claude', 'worktrees', 'lane');
    spawnSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'pr/toolchain/x', wt]);
    assert.equal(run(main, 'open', 'toolchain', 'finish the toolchain').status, 0);
    const binding = () => ({ slug: 'toolchain', authority: readTask(main, 'toolchain').authority });
    return { main, wt, binding };
  }
  const file = (root, f) => fs.readFileSync(path.join(tasksDir(root), 'toolchain', f));

  it('copies TASK.md and JOURNAL.md byte for byte into the worktree, idempotently', () => {
    const { main, wt, binding } = opened();
    assert.match(commitRecord(wt, 'toolchain', { binding }), /copied toolchain \(TASK\.md, JOURNAL\.md\).*git add/);
    for (const f of ['TASK.md', 'JOURNAL.md']) assert.deepEqual(file(wt, f), file(main, f));
    assert.match(commitRecord(wt, 'toolchain', { binding }), /already holds/);
  });

  it('PLANTED CONTROL: a modified copy in the worktree is refused, never overwritten', () => {
    const { wt, binding } = opened();
    fs.mkdirSync(path.join(tasksDir(wt), 'toolchain'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir(wt), 'toolchain', 'JOURNAL.md'), 'edited\n');
    assert.throws(() => commitRecord(wt, 'toolchain', { binding }), /different JOURNAL\.md.*never overwritten/);
    assert.equal(file(wt, 'JOURNAL.md').toString(), 'edited\n');
  });

  it('PLANTED CONTROL: an unbound session, or one bound elsewhere, is refused', () => {
    const { wt, main } = opened();
    assert.throws(() => commitRecord(wt, 'toolchain', { binding: () => null }), /not bound to task toolchain/);
    assert.throws(() => commitRecord(wt, 'toolchain', { binding: () => ({ slug: 'other', authority: 'x' }) }), /not bound to task toolchain/);
    const stale = () => ({ slug: 'toolchain', authority: 'not-the-record' });
    assert.throws(() => commitRecord(wt, 'toolchain', { binding: stale }), /not bound to task toolchain/);
    assert.equal(fs.existsSync(path.join(tasksDir(wt), 'toolchain')), false);
    const cli = run(wt, 'commit-record', 'toolchain'); // no dev-lab venv here: no binding can be read
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /not bound to task toolchain/);
    assert.ok(readTask(main, 'toolchain'));
  });

  it('PLANTED CONTROL: a task that is not open in the main checkout is refused', () => {
    const { wt } = opened();
    const binding = () => ({ slug: 'nothing-open', authority: 'x' });
    assert.throws(() => commitRecord(wt, 'nothing-open', { binding }), /no open task nothing-open in the main checkout/);
  });

  it('the task guard admits task.js commit-record and names it as the door', () => {
    const d = decideTaskGuard({ tool_name: 'Bash', tool_input: { command: `node ${TASK} commit-record toolchain` } });
    assert.equal(d.deny, false);
    const refused = decideTaskGuard({ tool_name: 'Bash', tool_input: { command: 'cp a/TASK.md .claude/tasks/toolchain/TASK.md' } });
    assert.match(refused.reason, /task\.js commit-record <slug>/);
  });
});
