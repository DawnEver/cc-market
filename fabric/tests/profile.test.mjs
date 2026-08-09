// Tests for engine/profile.mjs — spawn profiles (G2). The spawn point is the only place
// credential SUBTRACTION cannot be bypassed: a profile names what a child may do
// (tools, permission mode) and which env vars it must NOT inherit.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-prof-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProfile, applyProfileEnv, profileArgs } from '../engine/profile.mjs';

test('resolveProfile: object passes through; unknown name throws with available list', () => {
  const p = { allowedTools: 'Read,Grep', permissionMode: 'default' };
  assert.deepEqual(resolveProfile(p, {}), p);
  assert.equal(resolveProfile(undefined, {}), null);
  const cfg = { profiles: { author: { envDeny: ['MAIN_TOKEN'] } } };
  assert.deepEqual(resolveProfile('author', cfg), { envDeny: ['MAIN_TOKEN'] });
  assert.throws(() => resolveProfile('nope', cfg), /nope.*author/s);
});

test('applyProfileEnv subtracts envDeny vars and never adds', () => {
  const env = { A: '1', MAIN_TOKEN: 'secret', B: '2' };
  const out = applyProfileEnv(env, { envDeny: ['MAIN_TOKEN', 'ABSENT'] });
  assert.deepEqual(out, { A: '1', B: '2' });
  assert.deepEqual(applyProfileEnv(env, null), env);
});

test('profileArgs maps allowedTools/permissionMode to CLI flags', () => {
  assert.deepEqual(profileArgs({ allowedTools: 'Read,Grep', permissionMode: 'plan' }),
    ['--allowedTools', 'Read,Grep', '--permission-mode', 'plan']);
  assert.deepEqual(profileArgs(null), []);
  assert.deepEqual(profileArgs({ allowedTools: ['Read', 'Grep'] }), ['--allowedTools', 'Read,Grep']);
});

test('openSession applies profile: env subtracted, flags appended', async () => {
  const { openSession } = await import('../engine/open-session.mjs');
  const { clearConfigCache } = await import('../engine/providers.mjs');
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'prof-')), 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({ 'env:deepseek': { ANTHROPIC_FOUNDRY_API_KEY: 'k', SECRET_TOKEN: 'x' } }));
  clearConfigCache();
  let seen = null;
  const fake = (bin, args, opts) => {
    seen = { args, env: opts.env };
    const { EventEmitter } = eventsMod;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => queueMicrotask(() => child.emit('close', 0)) };
    return child;
  };
  const runDir = mkdtempSync(join(tmpdir(), 'prof-run-'));
  const s = await openSession({
    provider: 'deepseek', runDir, configPath: cfgPath, _spawn: fake, _bin: 'fake',
    profile: { allowedTools: 'Read', envDeny: ['SECRET_TOKEN'] },
  });
  await s.close();
  assert.ok(!('SECRET_TOKEN' in seen.env), 'denied env var must not reach the child');
  assert.ok(seen.args.includes('--allowedTools'), 'profile tools flag missing');
});
import * as eventsMod from 'node:events';
