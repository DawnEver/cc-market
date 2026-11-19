// session-binding.mjs — where a session's task binding lives: PER SESSION, never per repo (user ruling D34,
// 2026-11-17). ONE file, `<machine home>/state/sessions/<session>.json` =
//   {"session": "<id>", "task": "<slug>@<authority>", "ledger": {"repo_key": "<name>-<digest>", "path": "<ledger>"}}
// so every repo's push/commit check reads the same file, and a session bound from repo A pushes from repo B
// under its task (measured O29: a binding in one repo's ledger was invisible from another).
//
// The machine home is lab_commons' (lab_commons.home.home). rem cannot import Python, so it reads ONE variable,
// LAB_COMMONS_HOME, which dev-lab writes from lab_commons.home into the user Claude settings
// (`python -m dev_lab.dev.remhome --install`); unset, rem binds nothing and names that command -- it never guesses
// a default. The record shape and repo key are pinned on both sides by one fixture
// (tests/fixtures/session-binding.json, byte-identical in dev-lab's tests/_rem_fixtures/). The repo key is
// lab_commons.repostate.repo_key's rule: the main checkout's name, and the first 12 hex of the SHA-256 of its git
// common dir as the filesystem resolves it, case-folded where the filesystem ignores case.
//
// The retired per-repo store `<ledger>/.bindings/<session>.json` is never read for a binding. Its records move
// ONCE (migrateRetiredBindings, run by migrations/migrate.mjs); a record still there is named by retiredBinding so
// a reader can refuse it with that migration (FORMATS-MIGRATE-ONCE).

import { readFileSync, readdirSync, existsSync, realpathSync, rmSync, rmdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { atomicWriteFile } from '../shared/atomic-write.mjs';

export const HOME_ENV = 'LAB_COMMONS_HOME';
export const HOME_DOOR = `${HOME_ENV} is unset, so rem has no machine home to bind into. `
  + 'Door: `python -m dev_lab.dev.remhome --install` (dev-lab) writes it into the user Claude settings; restart the session';
export const RETIRED_BINDINGS = '.bindings';
export const MIGRATE_BINDINGS_DOOR = 'move it once with rem\'s migration -- the /migrate skill, or node '
  + '<rem plugin>/migrations/migrate.mjs <main checkout> -- which moves every record of that store into the session store';
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CASELESS = new Set(['win32', 'darwin']);
const posix = p => String(p).replace(/\\/g, '/');

function claudeSettingsHome(env) {
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.claude');
  try {
    const val = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))?.env?.[HOME_ENV];
    return typeof val === 'string' && val ? val : null;
  } catch { return null; }
}

// The machine home: $LAB_COMMONS_HOME, else `env.LAB_COMMONS_HOME` from the user Claude settings
// (`remhome --install`'s target, so Codex and Antigravity hooks read the same declaration without
// duplicating it), with a leading ~ expanded. Unset throws HOME_DOOR.
export function machineHome(env = process.env) {
  const home = env[HOME_ENV] || (env === process.env ? claudeSettingsHome(env) : null);
  if (!home) throw new Error(HOME_DOOR);
  const tilde = /^~(?:$|[\\/]+(.*))$/s.exec(home);
  if (!tilde) return home;
  return tilde[1] ? join(homedir(), ...tilde[1].split(/[\\/]+/).filter(Boolean)) : homedir();
}

// THE ONE PATH of `session`'s binding, the same from every repo.
export function bindingFile(session, env = process.env) {
  if (!SESSION_RE.test(String(session || ''))) throw new Error('the harness named no plain session id to bind');
  return join(machineHome(env), 'state', 'sessions', `${session}.json`);
}

// lab_commons.repostate.repo_key of the repo whose common git dir is spelled `common`: `<name>-<digest>`.
export function repoKey(common, { caseless = CASELESS.has(process.platform) } = {}) {
  const text = posix(common).replace(/\/+$/, '');
  const parts = text.split('/');
  const name = parts.at(-1) === '.git' ? parts.at(-2) : parts.at(-1);
  const digest = createHash('sha256').update(caseless ? text.toLowerCase() : text, 'utf8').digest('hex').slice(0, 12);
  return `${name}-${digest}`;
}

// The ledger the record names: its repo key and its directory, from the main checkout `checkout`.
export function ledgerOf(checkout, tasks) {
  const dotGit = join(checkout, '.git');
  let common = dotGit;
  try { common = realpathSync.native(dotGit); } catch { /* the spelled path is the key */ }
  return { repo_key: repoKey(common), path: posix(tasks) };
}

// Write `session`'s binding to task id `task` of the ledger `ledger` ({repo_key, path}); the file written.
export function writeBinding(session, task, ledger, env = process.env) {
  const file = bindingFile(session, env);
  atomicWriteFile(file, JSON.stringify({ session, task, ledger }));
  return file;
}

// `session`'s binding: {slug, authority, ledger, repoKey, file}, or null (none written, or malformed). Never guessed.
export function readBinding(session, env = process.env) {
  let file, record;
  try { file = bindingFile(session, env); record = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const m = record?.session === session && String(record.task || '').match(/^([a-z0-9]+(?:-[a-z0-9]+)*)@(\S+)$/);
  const ledger = record?.ledger;
  if (!m || typeof ledger?.path !== 'string') return null;
  return { slug: m[1], authority: m[2], ledger: ledger.path, repoKey: ledger.repo_key, file };
}

// The retired per-repo record of `session` below the ledger `tasks`, when one is still there; else null.
export function retiredBinding(tasks, session) {
  if (!SESSION_RE.test(String(session || ''))) return null;
  const old = join(tasks, RETIRED_BINDINGS, `${session}.json`);
  return existsSync(old) ? old : null;
}

// Whether two ledger paths are one directory (case ignored where the filesystem ignores it).
export function sameLedger(a, b) {
  const key = p => { const t = posix(p).replace(/\/+$/, ''); return CASELESS.has(process.platform) ? t.toLowerCase() : t; };
  return key(a) === key(b);
}

// THE ONE-SHOT MIGRATION of the retired store below the ledger `tasks` of main checkout `checkout`: every record
// moves to its session file (with the ledger it was found in) and the old file is deleted; the store directory goes
// when empty. A session file already there wins and the old record is deleted only when it names the same task;
// otherwise both stay and the conflict is reported. A second run finds nothing: { moved, dropped, conflicts, bad }.
export function migrateRetiredBindings(checkout, tasks, { dryRun = false, env = process.env } = {}) {
  const dir = join(tasks, RETIRED_BINDINGS);
  const done = { moved: [], dropped: [], conflicts: [], bad: [] };
  if (!existsSync(dir)) return done;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const old = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(old, 'utf8')); } catch { done.bad.push(posix(old)); continue; }
    const session = basename(name, '.json');
    if (record?.session !== session || typeof record.task !== 'string' || !SESSION_RE.test(session)) {
      done.bad.push(posix(old));
      continue;
    }
    const target = bindingFile(session, env);
    if (existsSync(target)) {
      const there = readBinding(session, env);
      if (there && `${there.slug}@${there.authority}` === record.task) {
        done.dropped.push(posix(old));
        if (!dryRun) rmSync(old);
      } else {
        done.conflicts.push({ old: posix(old), kept: posix(target) });
      }
      continue;
    }
    done.moved.push({ from: posix(old), to: posix(target) });
    if (!dryRun) { writeBinding(session, record.task, ledgerOf(checkout, tasks), env); rmSync(old); }
  }
  if (!dryRun && readdirSync(dir).length === 0) rmdirSync(dir);
  return done;
}
