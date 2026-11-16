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
import { readTask, listTasks, resolveTask, readSessionBinding, sessionOf, tasksDir, BINDINGS, taskSummary, SUMMARY_BYTES, STATUS_BYTES } from '../scripts/tasks.mjs';
import { VERBS } from '../scripts/task-verbs.mjs';
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

  it('numbers the next decision max+1, never count+1 (PLANTED: a gap would repeat an ID)', () => {
    const root = repo();
    run(root, 'open', 't', 'goal');
    fs.appendFileSync(path.join(tasksDir(root), 't', 'JOURNAL.md'), `- ${today} D1: a
- ${today} D3: c
`);
    assert.equal(run(root, 'decide', 'd', '--task', 't').status, 0);
    assert.match(journal(root, 't'), /^- \S+ D4: d$/m, 'count+1 would have written a second D3');
  });

  it('allocates unique IDs under a lock when sessions append at once', async () => {
    const root = repo();
    run(root, 'open', 't', 'goal');
    const { spawn } = await import('node:child_process');
    const one = (i) => new Promise((done) => spawn(process.execPath, [TASK, i % 2 ? 'decide' : 'open-item', `x${i}`, '--task', 't'],
      { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } }).on('exit', done));
    const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => one(i)));
    assert.deepEqual(codes, Array(10).fill(0));
    const ids = journal(root, 't').match(/^- \S+ (D\d+|O\d+ open):/gm).map((l) => l.split(' ')[2]);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10, `duplicate IDs: ${ids.join(' ')}`);
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
    assert.equal(resolveTask(wt, {}), null, 'with no binding file nothing is bound, never guessed');
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

  it('reads the binding file from the ledger, one file, for this session only', () => {
    const root = repo();
    run(root, 'open', 'feature-x', 'g');
    const authority = authorityOf(root, 'feature-x');
    const dir = path.join(tasksDir(root), BINDINGS);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's-1.json'), JSON.stringify({ session: 's-1', task: `feature-x@${authority}` }));
    assert.deepEqual(readSessionBinding(root, { session: 's-1' }), { slug: 'feature-x', authority });
    assert.equal(resolveTask(root, { binding: start => readSessionBinding(start, { session: 's-1' }) }), 'feature-x');
    assert.equal(readSessionBinding(root, { session: 's-2' }), null, 'PLANTED CONTROL: another session is unbound');
    fs.writeFileSync(path.join(dir, 's-3.json'), JSON.stringify({ session: 's-1', task: `feature-x@${authority}` }));
    assert.equal(readSessionBinding(root, { session: 's-3' }), null, 'a record naming another session binds nothing');
    fs.writeFileSync(path.join(dir, 's-4.json'), 'not json');
    assert.equal(readSessionBinding(root, { session: 's-4' }), null);
    assert.equal(readSessionBinding(root, { session: '../s-1' }), null, 'a session id is never a path');
    assert.equal(sessionOf({ CLAUDE_CODE_SESSION_ID: 's-1' }), 's-1');
    assert.equal(sessionOf({ CODEX_THREAD_ID: 't-1' }), 't-1');
    assert.equal(sessionOf({}), '');
    assert.deepEqual(listTasks(root).map(t => t.slug), ['feature-x'], 'the bindings directory is not a task');
  });

  it('task.js status names the door when nothing is bound', () => {
    const r = run(repo(), 'status');
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

describe('the ledger is repo state, one place for every worktree (cc-market #20)', () => {
  function twoTrees() {
    const main = repo();
    spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const trees = ['a', 'b'].map(name => {
      const wt = path.join(main, '.claude', 'worktrees', name);
      spawnSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', `pr/toolchain/${name}`, wt]);
      fs.mkdirSync(path.join(wt, '.claude', 'memory'), { recursive: true });
      return wt;
    });
    return { main, a: trees[0], b: trees[1] };
  }
  const bindIn = (root, session, slug) => {
    const dir = path.join(tasksDir(root), BINDINGS);
    fs.mkdirSync(dir, { recursive: true });
    const task = `${slug}@${readTask(root, slug).authority}`;
    fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({ session, task }));
  };
  const runAs = (root, session, ...args) => spawnSync(process.execPath, [TASK, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, CODEX_THREAD_ID: '', CLAUDE_PROJECT_DIR: root },
  });

  it('a task opened in worktree A is resolved, bound and journaled from worktree B', () => {
    const { main, a, b } = twoTrees();
    assert.equal(run(a, 'open', 'toolchain', 'finish the toolchain').status, 0);
    assert.equal(tasksDir(a), tasksDir(b));
    assert.equal(tasksDir(a), tasksDir(main));
    assert.equal(fs.existsSync(path.join(a, '.claude', 'tasks')), false, 'nothing lands in the opening tree');
    assert.deepEqual(listTasks(b).map(t => t.slug), ['toolchain']);
    assert.equal(runAs(b, 'sess-b', 'log', 'orphan').status, 1, 'PLANTED CONTROL: an unbound session is refused');
    bindIn(b, 'sess-b', 'toolchain');
    assert.match(runAs(b, 'sess-b', 'status').stdout, /^task toolchain [(]open/m);
    const logged = runAs(b, 'sess-b', 'log', 'progress from b');
    assert.equal(logged.status, 0, logged.stderr);
    assert.match(journal(a, 'toolchain'), /progress: progress from b$/m, 'B journaled into the one ledger');
    assert.match(runAs(a, 'sess-b', 'status').stdout, /^task toolchain [(]open/m, 'the same binding from tree A');
  });

  it('PLANTED CONTROL: a closed task is refused from every tree', () => {
    const { main, a, b } = twoTrees();
    run(a, 'open', 'toolchain', 'g');
    bindIn(a, 'sess-a', 'toolchain');
    assert.match(runAs(b, 'sess-a', 'status').stdout, /^task toolchain [(]open/m);
    run(b, 'close', 'toolchain');
    for (const tree of [main, a, b]) {
      assert.match(runAs(tree, 'sess-a', 'status').stdout, /no task bound/);
      assert.equal(runAs(tree, 'sess-a', 'log', 'late').status, 1);
    }
  });

  it('commit-record is retired, refused naming why', () => {
    const { b } = twoTrees();
    const r = run(b, 'commit-record', 'toolchain');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commit-record is retired .*never committed on a feature branch/);
  });

  it('the task guard refuses an agent writing a binding, and admits task.js place', () => {
    const write = file => decideTaskGuard({ tool_name: 'Write', tool_input: { file_path: file } }).deny;
    assert.ok(write('/r/.claude/tasks/.bindings/s.json'));
    assert.ok(write('C:\\r\\.claude\\tasks\\.bindings\\s.json'));
    assert.ok(!write('/r/.claude/tasks/x/notes.txt'), 'PLANTED CONTROL: the file rule names only records and bindings');
    const shell = command => decideTaskGuard({ tool_name: 'Bash', tool_input: { command } }).deny;
    assert.ok(shell('echo {} > .claude/tasks/.bindings/s.json'));
    assert.equal(shell(`node ${TASK} place toolchain`), false);
  });
});

describe('place: a task a worktree holds in its own tree moves into the ledger (cc-market #18)', () => {
  function legacy() {
    const main = repo();
    spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const wt = path.join(main, '.claude', 'worktrees', 'lane');
    spawnSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'lane', wt]);
    assert.equal(run(main, 'open', 'toolchain', 'finish the toolchain').status, 0);
    const own = path.join(wt, '.claude', 'tasks', 'toolchain');
    fs.cpSync(path.join(tasksDir(main), 'toolchain'), own, { recursive: true }); // the worktree's own record
    fs.rmSync(path.join(tasksDir(main), 'toolchain'), { recursive: true });
    return { main, wt, own };
  }

  it('copies the worktree\'s open task into the ledger, once, byte for byte', () => {
    const { main, wt, own } = legacy();
    assert.equal(readTask(wt, 'toolchain'), null, 'the worktree copy is not the ledger');
    const r = run(wt, 'place', 'toolchain');
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['TASK.md', 'JOURNAL.md']) {
      const placed = fs.readFileSync(path.join(tasksDir(main), 'toolchain', f), 'utf8');
      assert.equal(placed, fs.readFileSync(path.join(own, f), 'utf8'));
    }
    assert.equal(readTask(wt, 'toolchain').status, 'open');
    assert.match(run(wt, 'place', 'toolchain').stdout, /already placed/);
  });

  it('PLANTED CONTROL: never overwrites a differing copy and never opens a task that is not open', () => {
    const { main, wt } = legacy();
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
});

describe('progressive disclosure', () => {
  const big = () => {
    const root = repo();
    run(root, 'open', 't', 'goal '.repeat(30).trim());
    const lines = [];
    for (let i = 1; i <= 30; i++) lines.push(`- ${today} O${i} open: ${'item text '.repeat(20)}${i}`);
    for (let i = 1; i <= 120; i++) lines.push(`- ${today} D${i}: decision ${'word '.repeat(40)}${i}`);
    lines.push(`- ${today} handoff: next: rerun the gate`);
    fs.appendFileSync(path.join(tasksDir(root), 't', 'JOURNAL.md'), lines.join('\n') + '\n');
    return root;
  };

  it('the per-prompt summary is one line within SUMMARY_BYTES, counts only, pointing at status', () => {
    const line = taskSummary(readTask(big(), 't'));
    assert.ok(Buffer.byteLength(line) <= SUMMARY_BYTES, `${Buffer.byteLength(line)} B: ${line}`);
    assert.match(line, /^task t: 30 open, 120 decisions, last D120 \(\d\d-\d\d\) ".*"; detail: task\.js status$/);
    assert.doesNotMatch(line, /item text/, 'no item text rides on every prompt');
  });

  it('task.js status fits STATUS_BYTES and names what it cut (PLANTED: 30 long items would not fit)', () => {
    const r = run(big(), 'status', 't');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Buffer.byteLength(r.stdout.trimEnd()) <= STATUS_BYTES, `${Buffer.byteLength(r.stdout)} B`);
    assert.match(r.stdout, /^open items: 30$/m);
    assert.match(r.stdout, /^ {2}\+\d+ more \(task\.js show t\)$/m, 'the cut is named, with its door');
    assert.match(r.stdout, /^ {2}D120 /m);
    assert.match(r.stdout, /^last handoff \(\S+\): next: rerun the gate$/m);
  });

  it('VERBS is the one verb list: every entry dispatches and a verb outside it points at help', () => {
    const root = repo();
    for (const { verb } of VERBS) {
      assert.doesNotMatch(run(root, verb).stderr, /unknown verb/, `${verb} is in VERBS but task.js does not dispatch it`);
    }
    const r = run(root, 'bound');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown verb bound; every verb: task\.js help/, 'PLANTED: a verb outside VERBS is refused');
    assert.deepEqual(JSON.parse(run(root, 'verbs', '--json').stdout).map((v) => v.verb), VERBS.map((v) => v.verb));
  });

  it('no doc restates the journal verb list or names a retired verb', () => {
    const docs = ['README.md', 'AGENTS.md', 'commands/task.md', 'docs/architecture.md',
      'skills/rem/reference/tasks.md', 'skills/rem/reference/scripts.md'];
    for (const doc of docs) {
      const text = fs.readFileSync(path.join(REM, doc), 'utf8');
      assert.doesNotMatch(text, /log\|decide|`log`, `decide`/, `${doc} restates the verb list`);
      assert.doesNotMatch(text, /distill-status|task\.js bound/, `${doc} names a retired verb`);
    }
  });
});
