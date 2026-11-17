// session-binding.test.mjs — a binding is PER SESSION (D34): one file in the machine home that every repo reads,
// pinned against dev-lab by one cross-language fixture; the retired per-repo store migrates ONCE and is refused
// by name, never read.
import { TEST_HOME } from './user-grant.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasksDir, readSessionBinding, unboundReason } from '../scripts/tasks.mjs';
import {
  HOME_ENV, machineHome, bindingFile, repoKey, readBinding, writeBinding, ledgerOf, retiredBinding, migrateRetiredBindings,
} from '../scripts/session-binding.mjs';
import { migrate } from '../migrations/migrate.mjs';

const REM = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(REM, 'hooks', 'user-prompt.js');
const TASK = path.join(REM, 'scripts', 'task.js');
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/session-binding.json', import.meta.url), 'utf8'));
const SESSION = 's-cross';

function freshHome() {
  process.env.LAB_COMMONS_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rem-mhome-')), 'machine-home');
  return process.env.LAB_COMMONS_HOME;
}

function repo(name) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rem-sb-')), name);
  fs.mkdirSync(path.join(root, '.claude', 'memory'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  return root;
}

const env = () => ({ ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' });
const prompt = (root, text) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ prompt: text, cwd: root, session_id: SESSION, hook_event_name: 'UserPromptSubmit' }),
  encoding: 'utf8', env: env(),
});
function open(root, slug) {
  prompt(root, `/rem:task open ${slug} "a goal"`);
  const r = spawnSync(process.execPath, [TASK, 'open', slug, 'a goal'], { cwd: root, encoding: 'utf8', env: { ...env(), CLAUDE_PROJECT_DIR: root } });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(tasksDir(root), slug, 'TASK.md'), 'utf8').match(/^authority: (\S+)$/m)[1];
}
function plantRetired(root, session, task) {
  const dir = path.join(tasksDir(root), '.bindings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({ session, task }));
  return path.join(dir, `${session}.json`);
}

describe('the cross-language fixture (byte-identical in dev-lab tests/_rem_fixtures/)', () => {
  it('is the path, the repo key and the record rem writes', () => {
    const home = path.join(os.tmpdir(), 'fixture-home');
    assert.equal(bindingFile(FIXTURE.session, { [HOME_ENV]: home }), path.join(home, FIXTURE.relative_path));
    assert.throws(() => machineHome({}), /LAB_COMMONS_HOME is unset.*dev_lab\.dev\.remhome --install/,
      'unset: no guessed default, the variable and its door are named');
    assert.equal(repoKey(FIXTURE.common_dir, { caseless: FIXTURE.caseless }), FIXTURE.repo_key);
    assert.notEqual(repoKey(FIXTURE.common_dir, { caseless: false }), repoKey(FIXTURE.common_dir.toLowerCase(), { caseless: false }),
      'PLANTED CONTROL: a case-sensitive key tells two spellings apart');
    const fixtureEnv = { [HOME_ENV]: home };
    fs.rmSync(path.dirname(bindingFile(FIXTURE.session, fixtureEnv)), { recursive: true, force: true });
    assert.equal(readBinding(FIXTURE.session, fixtureEnv), null, 'PLANTED CONTROL: nothing written yet');
    writeBinding(FIXTURE.session, FIXTURE.record.task, FIXTURE.record.ledger, fixtureEnv);
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingFile(FIXTURE.session, fixtureEnv), 'utf8')), FIXTURE.record);
    fs.rmSync(path.join(os.tmpdir(), 'fixture-home'), { recursive: true, force: true });
  });
});

describe('with no machine home declared', () => {
  it('the user\'s prompt binds nothing and says why, naming the variable and the command that sets it', () => {
    freshHome();
    const root = repo('unset');
    open(root, 'toolchain');
    const saved = process.env.LAB_COMMONS_HOME;
    delete process.env.LAB_COMMONS_HOME;
    try {
      const r = prompt(root, 'task: toolchain');
      const said = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      assert.match(said, /binds nothing: LAB_COMMONS_HOME is unset/);
      assert.match(said, /python -m dev_lab\.dev\.remhome --install/);
      assert.match(unboundReason(root, { session: SESSION }), /LAB_COMMONS_HOME is unset/);
    } finally { process.env.LAB_COMMONS_HOME = saved; }
    assert.equal(readBinding(SESSION), null, 'PLANTED CONTROL: declared again, still nothing was written');
  });
});

describe('a binding written from repo A is read from repo B', () => {
  it('lands in the machine home, names A\'s ledger, and is the same file from B', () => {
    freshHome();
    const a = repo('repo-a'), b = repo('repo-b');
    const authority = open(a, 'toolchain');
    assert.equal(readBinding(SESSION), null, 'PLANTED CONTROL: unbound');
    prompt(a, 'task: toolchain');
    const bound = readBinding(SESSION);
    assert.equal(`${bound.slug}@${bound.authority}`, `toolchain@${authority}`);
    assert.equal(bound.ledger, tasksDir(a).replace(/\\/g, '/'));
    assert.equal(bound.repoKey, ledgerOf(a, tasksDir(a)).repo_key);
    assert.deepEqual(readSessionBinding(a, { session: SESSION }), { slug: 'toolchain', authority });
    assert.equal(readSessionBinding(b, { session: SESSION }), null, 'rem journals only into the ledger the task lives in');
    assert.match(unboundReason(b, { session: SESSION }), /bound to task toolchain@\S+ of another repo's ledger/);
  });
});

describe('the retired per-repo store', () => {
  it('is never read, and a record still there is refused by name with its migration', () => {
    freshHome();
    const root = repo('legacy');
    const authority = open(root, 'toolchain');
    const old = plantRetired(root, SESSION, `toolchain@${authority}`);
    assert.equal(readSessionBinding(root, { session: SESSION }), null);
    assert.equal(retiredBinding(tasksDir(root), SESSION), old);
    const why = unboundReason(root, { session: SESSION });
    assert.ok(why.includes(old) && why.includes(bindingFile(SESSION)) && why.includes('migrations/migrate.mjs'), why);
    assert.equal(retiredBinding(tasksDir(root), 'other'), null, 'PLANTED CONTROL: another session has no old record');
  });

  it('migrates exactly once: moved, deleted, and a second run is a no-op', async () => {
    freshHome();
    const root = repo('legacy');
    const authority = open(root, 'toolchain');
    const one = plantRetired(root, 's-1', `toolchain@${authority}`);
    const two = plantRetired(root, 's-2', `toolchain@${authority}`);
    const first = await migrate(root);
    assert.equal(first.plan.bindings.moved.length, 2);
    assert.ok(!fs.existsSync(one) && !fs.existsSync(two), 'the old records are deleted');
    assert.ok(!fs.existsSync(path.join(tasksDir(root), '.bindings')), 'and their directory');
    assert.deepEqual(readSessionBinding(root, { session: 's-1' }), { slug: 'toolchain', authority });
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingFile('s-2'), 'utf8')).ledger, ledgerOf(root, tasksDir(root)));
    const second = await migrate(root);
    assert.deepEqual(second.plan.bindings, { moved: [], dropped: [], conflicts: [], bad: [] }, 'a second run moves nothing');
    assert.ok(!second.summary.some(line => /binding/.test(line)));
  });

  it('a session already in the store wins; a different task is a reported conflict, both kept', () => {
    freshHome();
    const root = repo('legacy');
    const authority = open(root, 'toolchain');
    writeBinding('s-1', `toolchain@${authority}`, ledgerOf(root, tasksDir(root)));
    writeBinding('s-2', 'other@x', ledgerOf(root, tasksDir(root)));
    const same = plantRetired(root, 's-1', `toolchain@${authority}`);
    const differ = plantRetired(root, 's-2', `toolchain@${authority}`);
    const dry = migrateRetiredBindings(root, tasksDir(root), { dryRun: true });
    assert.ok(fs.existsSync(same), 'a dry run writes nothing');
    const done = migrateRetiredBindings(root, tasksDir(root));
    assert.deepEqual([dry.dropped.length, done.dropped.length, done.conflicts.length, done.moved.length], [1, 1, 1, 0]);
    assert.ok(!fs.existsSync(same) && fs.existsSync(differ));
    assert.equal(readBinding('s-2').slug, 'other', 'the store\'s record is never overwritten');
  });
});
