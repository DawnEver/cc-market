import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BUILTIN_POLICY, reviewPolicy, principlesFile } from '../scripts/lib/ai-lab.mjs';
import { applyPolicy, globMatch } from '../scripts/lib/manifest.mjs';
import { disposedTrailer, parseDisposedTrailers } from '../scripts/lib/findings.mjs';

const POLICY = { schema: 1, principles: [{ id: 'occams-razor', name: 'Occam', statement: 's' }], code: ['src/**', '*.py'],
  not_code: ['src/gen/**'], max_total_bytes: 500, max_file_bytes: 100, blocking: [], summary: { cite: [] } };

const fakeRun = (answers) => {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); return answers.shift(); };
  return { run, calls };
};

test('the policy is dev-lab\'s: `-m dev_lab.dev.reviewpolicy --json --repo <root>` through the first interpreter that answers', () => {
  const { run, calls } = fakeRun([{ status: 1, stdout: '', stderr: 'No module named dev_lab' }, { status: 0, stdout: JSON.stringify(POLICY) }]);
  assert.deepEqual(reviewPolicy('/repo', { pythons: ['/repo/.venv/py', '/ailab/py'], run }), POLICY);
  assert.deepEqual(calls.map((c) => c.cmd), ['/repo/.venv/py', '/ailab/py']);
  assert.deepEqual(calls[1].args, ['-m', 'dev_lab.dev.reviewpolicy', '--json', '--repo', '/repo']);
});

test('a project with no dev-lab gets the built-in policy: everything is code, no caps, no principles', () => {
  const { run } = fakeRun([{ status: 1, stdout: '' }]);
  assert.deepEqual(reviewPolicy('/repo', { pythons: ['/py', undefined], run }), BUILTIN_POLICY);
  assert.deepEqual(reviewPolicy('/repo', { pythons: [], run }), BUILTIN_POLICY);
  assert.deepEqual(BUILTIN_POLICY.principles, []);
});

test('an unknown policy schema is refused, never half-read', () => {
  const { run } = fakeRun([{ status: 0, stdout: JSON.stringify({ ...POLICY, schema: 2 }) }]);
  assert.throws(() => reviewPolicy('/repo', { pythons: ['/py'], run }), /schema 2/);
});

test('the principles file ai-lab reads carries the policy\'s principles', () => {
  assert.deepEqual(JSON.parse(readFileSync(principlesFile(POLICY), 'utf8')), { principles: POLICY.principles });
});

test('globs: ** spans directories, * stays inside one, a slashless glob matches the basename', () => {
  assert.ok(globMatch('src/a/b.js', 'src/**'));
  assert.ok(globMatch('x/y.py', '*.py'));
  assert.ok(!globMatch('src/a/b.js', 'src/*.js'));
  assert.ok(globMatch('src/b.js', 'src/*.js'));
});

test('the policy scopes the manifest: outside code, inside not_code, or over max_file_bytes is excluded with its reason', () => {
  const entries = [{ path: 'src/a.js', added: 1, deleted: 0 }, { path: 'docs/x.md' }, { path: 'src/gen/g.js' }, { path: 'src/big.js' }];
  const sizes = new Map([['src/a.js', 50], ['src/big.js', 101]]);
  const { entries: kept, excluded } = applyPolicy(entries, POLICY, sizes);
  assert.deepEqual(kept.map((e) => e.path), ['src/a.js']);
  assert.deepEqual(excluded, [
    { path: 'docs/x.md', reason: 'not code (review policy)' },
    { path: 'src/gen/g.js', reason: 'not code (review policy)' },
    { path: 'src/big.js', reason: 'over max_file_bytes (review policy)' },
  ]);
  assert.equal(applyPolicy(entries, BUILTIN_POLICY, sizes).entries.length, 4);
});

test('a disposition is a `Review-Disposed: <id> -- <reason>` trailer, and reads back', () => {
  const line = disposedTrailer('F-0123456789ab', 'intended: the fallback is the base case');
  assert.equal(line, 'Review-Disposed: F-0123456789ab -- intended: the fallback is the base case');
  const msg = `feat: x\n\nbody\n\n${line}\nReview-Disposed: F-aaaaaaaaaaaa -- dup of F-0123456789ab\nClaude-Session: s\n`;
  assert.deepEqual(parseDisposedTrailers(msg), [
    { id: 'F-0123456789ab', reason: 'intended: the fallback is the base case' },
    { id: 'F-aaaaaaaaaaaa', reason: 'dup of F-0123456789ab' },
  ]);
  assert.throws(() => disposedTrailer('F-0123456789ab', ''), /reason/);
  assert.throws(() => disposedTrailer('not an id', 'r'), /id/);
  assert.throws(() => disposedTrailer('F-0123456789ab', 'two\nlines'), /one line/);
});

test('collectManifest reviews only what the policy scopes, and max_total_bytes caps the inline diff', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { collectManifest } = await import('../scripts/lib/git-manifest.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sr-policy-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'src', 'a.js'), 'x\n'.repeat(20));
    writeFileSync(join(dir, 'docs', 'x.md'), 'doc\n');
    git('add', '.');
    const scoped = collectManifest(dir, { range: 'HEAD', limit: 20000, policy: { ...POLICY, max_file_bytes: 10000, max_total_bytes: 50 } });
    assert.equal(scoped.stats.files, 1);
    assert.match(scoped.excludedSummary, /not code \(review policy\)/);
    assert.equal(scoped.mode, 'agent'); // the src diff is over max_total_bytes: listed, not inlined
    assert.equal(collectManifest(dir, { range: 'HEAD', limit: 20000, policy: POLICY }).stats.files, 0); // over max_file_bytes
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('post-review --dispose prints the trailer line for `git commit --trailer`, and refuses a bad one', async () => {
  const { execFileSync } = await import('node:child_process');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'post-review.js');
  const out = execFileSync('node', [script, '--dispose', 'F-0123456789ab', '--reason', 'intended'], { encoding: 'utf8', windowsHide: true });
  assert.equal(out, 'Review-Disposed: F-0123456789ab -- intended\n');
  assert.throws(() => execFileSync('node', [script, '--dispose', 'F-0123456789ab'], { stdio: 'pipe', windowsHide: true }), /reason/);
});
