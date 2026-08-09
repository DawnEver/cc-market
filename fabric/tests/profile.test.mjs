// Tests for engine/profile.mjs — spawn profiles (G2). The spawn point is the only place
// credential SUBTRACTION cannot be bypassed: a profile names what a child may do
// (tools, permission mode) and which env vars it must NOT inherit.
process.env.FABRIC_JOURNAL_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fj-prof-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as eventsMod from 'node:events';
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

// ── sharp-review 2026-08-09 fixes ──

// SR-017/002: extraArgs must NOT override the profile — profile flags win.
test('profile flags beat extraArgs (last-flag-wins order + strip)', async () => {
  const { openSession } = await import('../engine/open-session.mjs');
  const { clearConfigCache } = await import('../engine/providers.mjs');
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'prof2-')), 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({ 'env:deepseek': { ANTHROPIC_FOUNDRY_API_KEY: 'k' } }));
  clearConfigCache();
  let seen = null;
  const fake = (bin, args) => {
    seen = args;
    const { EventEmitter } = eventsMod;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => queueMicrotask(() => child.emit('close', 0)) };
    return child;
  };
  const s = await openSession({
    provider: 'deepseek', runDir: mkdtempSync(join(tmpdir(), 'prof2-run-')), configPath: cfgPath,
    _spawn: fake, _bin: 'fake',
    profile: { allowedTools: 'Read', permissionMode: 'plan' },
    extraArgs: ['--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash'],
  });
  await s.close();
  const last = (flag) => seen.lastIndexOf(flag) >= 0 ? seen[seen.lastIndexOf(flag) + 1] : null;
  assert.equal(last('--permission-mode'), 'plan', 'profile permissionMode must win over extraArgs');
  assert.equal(last('--allowedTools'), 'Read', 'profile allowedTools must win over extraArgs');
});

// SR-002: permissionMode is validated against the CLI enum — a typo must throw, not no-op.
test('resolveProfile rejects an unknown permissionMode', () => {
  assert.throws(() => resolveProfile({ permissionMode: 'bypass' }, {}), /permissionMode/);
});

// ── toolsPreset (role tiers) ──

test('profileArgs maps toolsPreset to --tools (schema trimming)', () => {
  assert.deepEqual(profileArgs({ toolsPreset: 'exec' }),
    ['--tools', 'Bash,Read,Write,Edit,Glob,Grep']);
  const coord = profileArgs({ toolsPreset: 'coord' })[1].split(',');
  assert.deepEqual(coord, ['Read', 'Glob', 'Grep', 'Bash', 'SendMessage', 'PushNotification', 'WebFetch', 'WebSearch']);
  // no toolsPreset / "full" → no --tools flag (all built-in schemas injected)
  assert.deepEqual(profileArgs({}), []);
  assert.deepEqual(profileArgs({ toolsPreset: 'full' }), []);
  // composes with existing profile flags
  assert.deepEqual(profileArgs({ allowedTools: 'Read', toolsPreset: 'exec' }),
    ['--allowedTools', 'Read', '--tools', 'Bash,Read,Write,Edit,Glob,Grep']);
});

test('resolveProfile rejects an unknown toolsPreset', () => {
  assert.throws(() => resolveProfile({ toolsPreset: 'hacker' }, {}), /toolsPreset/);
});

test('--tools is profile-owned: extraArgs cannot smuggle it past a profile', async () => {
  const { stripProfileOwnedFlags } = await import('../engine/profile.mjs');
  assert.deepEqual(stripProfileOwnedFlags(['--tools', 'Bash', '--model', 'x']), ['--model', 'x']);
});

// SR-009: envDeny is case-insensitive on Windows (env keys are).
test('applyProfileEnv envDeny is case-insensitive on win32', () => {
  const out = applyProfileEnv({ Secret_Token: 'x', KEEP: '1' }, { envDeny: ['SECRET_TOKEN'] }, 'win32');
  assert.deepEqual(out, { KEEP: '1' });
  const linux = applyProfileEnv({ Secret_Token: 'x' }, { envDeny: ['SECRET_TOKEN'] }, 'linux');
  assert.deepEqual(linux, { Secret_Token: 'x' }, 'linux keys are case-sensitive; distinct var survives');
});

// ── systemPromptFile injection ──

test('profileArgs maps systemPromptFile to --system-prompt-file', () => {
  assert.deepEqual(profileArgs({ systemPromptFile: 'C:/x/claude-base.md' }),
    ['--system-prompt-file', 'C:/x/claude-base.md']);
  assert.deepEqual(profileArgs({ toolsPreset: 'exec', systemPromptFile: 'C:/x/base.md' }),
    ['--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--system-prompt-file', 'C:/x/base.md']);
});

test('openSession injects fabric.systemPromptFile default + profile override wins', async () => {
  const { openSession } = await import('../engine/open-session.mjs');
  const { clearConfigCache } = await import('../engine/providers.mjs');
  const cfgPath = join(mkdtempSync(join(tmpdir(), 'sysf-')), 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({
    'env:deepseek': { ANTHROPIC_FOUNDRY_API_KEY: 'k' },
    fabric: { systemPromptFile: 'C:/default/claude-base.md' },
  }));
  clearConfigCache();
  let seen = null;
  const fake = (bin, args) => {
    seen = args;
    const { EventEmitter } = eventsMod;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => queueMicrotask(() => child.emit('close', 0)) };
    return child;
  };
  // default from config
  const s1 = await openSession({ provider: 'deepseek', runDir: mkdtempSync(join(tmpdir(), 'sysf1-')), configPath: cfgPath, _spawn: fake, _bin: 'fake' });
  await s1.close();
  assert.ok(seen.includes('--system-prompt-file') && seen[seen.indexOf('--system-prompt-file') + 1] === 'C:/default/claude-base.md');
  // profile overrides
  const s2 = await openSession({ provider: 'deepseek', runDir: mkdtempSync(join(tmpdir(), 'sysf2-')), configPath: cfgPath, _spawn: fake, _bin: 'fake', profile: { systemPromptFile: 'C:/profile/base.md' } });
  await s2.close();
  assert.ok(seen[seen.indexOf('--system-prompt-file') + 1] === 'C:/profile/base.md');
});

// ── style resolution ──

test('profile style resolves to built dist file (auto-build when missing)', async () => {
  const { openSession } = await import('../engine/open-session.mjs');
  const { clearConfigCache } = await import('../engine/providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'style-'));
  const cfgPath = join(dir, 'reg.json');
  writeFileSync(cfgPath, JSON.stringify({
    'env:deepseek': { ANTHROPIC_FOUNDRY_API_KEY: 'k' },
    fabric: { systemPromptFile: join(dir, 'platform', 'claude-base.md') },
  }));
  clearConfigCache();
  // fake platform dir: build.mjs + style source
  mkdirSync(join(dir, 'platform', 'dist'), { recursive: true });
  mkdirSync(join(dir, 'platform', '.claude', 'output-styles'), { recursive: true });
  writeFileSync(join(dir, 'platform', 'claude-base.md'), 'BASE\n');
  writeFileSync(join(dir, 'platform', '.claude', 'output-styles', 'academic.md'),
    '---\nname: Academic\n---\nACADEMIC BODY\n');
  const { execFileSync } = await import('node:child_process');
  writeFileSync(join(dir, 'platform', 'build.mjs'), `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(join(import.meta.dirname, 'dist'), { recursive: true });
writeFileSync(join(import.meta.dirname, 'dist', 'academic.claude.md'), 'BASE\\n\\nACADEMIC BODY\\n');
`);
  let seen = null;
  const fake = (bin, args) => { seen = args; const { EventEmitter } = eventsMod; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write: () => {}, end: () => queueMicrotask(() => c.emit('close', 0)) }; return c; };
  const s = await openSession({ provider: 'deepseek', runDir: mkdtempSync(join(tmpdir(), 'style-run-')), configPath: cfgPath, _spawn: fake, _bin: 'fake', profile: { style: 'academic' } });
  await s.close();
  const idx = seen.indexOf('--system-prompt-file');
  assert.ok(idx >= 0, '--system-prompt-file must be injected for a style');
  assert.match(seen[idx + 1], /[\\/]dist[\\/]academic\.claude\.md$/);
  const dist = seen[idx + 1];
  assert.match(readFileSync(dist, 'utf8'), /ACADEMIC BODY/, 'dist must contain the built style body');
});
