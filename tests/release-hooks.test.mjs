import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function findBash() {
  if (process.env.BASH && existsSync(process.env.BASH)) return process.env.BASH;
  if (process.platform !== 'win32') return 'bash';
  // Git for Windows always ships bash next to its cmd/ directory. `where git` is more
  // reliable than hard-coding Program Files and also covers portable/custom installs.
  const gitExe = execFileSync('where.exe', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/).find(Boolean);
  const candidates = [
    resolve(dirname(gitExe), '..', 'bin', 'bash.exe'),
    resolve(dirname(gitExe), '..', 'usr', 'bin', 'bash.exe'),
    // `where git` may resolve Git for Windows' native executable under
    // <Git>/mingw64/bin rather than the cmd shim under <Git>/cmd.
    resolve(dirname(gitExe), '..', '..', 'bin', 'bash.exe'),
    resolve(dirname(gitExe), '..', '..', 'usr', 'bin', 'bash.exe'),
  ];
  const bash = candidates.find(existsSync);
  assert.ok(bash, `Git Bash not found beside ${gitExe}`);
  return bash;
}

const BASH = findBash();
const ZERO = '0'.repeat(40);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-market-release-'));
  mkdirSync(join(dir, 'scripts', 'git-hooks'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'));
  mkdirSync(join(dir, 'demo', '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'demo', 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'git-hooks', 'pre-push'), join(dir, 'scripts', 'git-hooks', 'pre-push'));
  cpSync(join(ROOT, 'scripts', 'release.sh'), join(dir, 'scripts', 'release.sh'));
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), '{"version":"1.2.3"}\n');
  writeFileSync(join(dir, 'demo', '.claude-plugin', 'plugin.json'), '{"name":"demo","version":"1.0.0"}\n');
  writeFileSync(join(dir, 'demo', 'scripts', 'run.mjs'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

function runHook(dir, input) {
  const result = spawnSync(BASH, ['scripts/git-hooks/pre-push', 'origin', 'unused'], {
    cwd: dir, input, encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, null, `Git Bash terminated without an exit code: ${result.stderr}`);
  return result;
}

test('pre-push rejects an unrelated tag and accepts the matching marketplace release tag', () => {
  const dir = fixture();
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'demo', 'scripts', 'run.mjs'), 'export const value = 2;\n');
  git(dir, 'commit', '-qam', 'plugin change');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', 'temporary');
  const input = `refs/heads/main ${head} refs/heads/main ${base}\n`;
  assert.equal(runHook(dir, input).status, 1);
  git(dir, 'tag', 'v1.2.3');
  assert.equal(runHook(dir, input).status, 0);
});

test('pre-push checks a newly-created branch against remote main', () => {
  const dir = fixture();
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  writeFileSync(join(dir, 'demo', 'scripts', 'run.mjs'), 'export const value = 3;\n');
  git(dir, 'commit', '-qam', 'plugin change');
  const head = git(dir, 'rev-parse', 'HEAD');
  const input = `refs/heads/topic ${head} refs/heads/topic ${ZERO}\n`;
  assert.equal(runHook(dir, input).status, 1);
});

test('release refuses to bump the same already-tagged HEAD twice', () => {
  const dir = fixture();
  git(dir, 'tag', 'v1.2.3');
  const result = spawnSync(BASH, ['scripts/release.sh'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HEAD is already release v1\.2\.3/);
  assert.equal(JSON.parse(execFileSync('git', ['show', 'HEAD:.claude-plugin/marketplace.json'], {
    cwd: dir, encoding: 'utf8',
  })).version, '1.2.3');
});
