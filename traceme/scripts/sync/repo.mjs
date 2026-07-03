import { spawnSync } from "../../shared/spawn.mjs";
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { openDb, getMeta, setMeta } from '../db.mjs';
import { hasKey } from '../crypto.mjs';
import { TRACEME_DIR } from '../lib.mjs';

export const SYNC_DIR = join(TRACEME_DIR, 'sync-repo');
let _deviceId = null;
let _syncRepoReady = false;

export function getDeviceId() {
  if (_deviceId) return _deviceId;
  openDb();
  _deviceId = getMeta('device_id');
  const canonical = `${userInfo().username}@${hostname().split('.')[0]}`;
  if (!_deviceId) {
    _deviceId = canonical;
    setMeta('device_id', _deviceId);
  } else if (_deviceId !== canonical && _deviceId.startsWith(canonical + '_')) {
    // Migrate: old format had a random timestamp suffix (worktree isolation would
    // create separate DBs each with a different suffix, counting as extra devices).
    _deviceId = canonical;
    setMeta('device_id', _deviceId);
  }
  return _deviceId;
}

export function getRemote() {
  if (process.env.TRACEME_SYNC_REMOTE) return process.env.TRACEME_SYNC_REMOTE;
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: SYNC_DIR, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

export function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd || SYNC_DIR,
    timeout: opts.timeout || 30000,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'traceme', GIT_AUTHOR_EMAIL: 'traceme@local', GIT_COMMITTER_NAME: 'traceme', GIT_COMMITTER_EMAIL: 'traceme@local' }
  });
  if (r.status !== 0 && !opts.ignoreError) {
    throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return r;
}

// Convert "YYYY-MM-DD" to the repo-relative snapshot path "YYYY/MM/DD/<device>.enc" —
// each device writes its own file directly to the main branch.
export function datePath(date) {
  const [y, m, d] = date.split('-');
  return `${y}/${m}/${d}/${getDeviceId()}.enc`;
}

export function ensureSyncRepo() {
  if (_syncRepoReady) return SYNC_DIR;
  if (!existsSync(SYNC_DIR)) {
    mkdirSync(SYNC_DIR, { recursive: true });
    git(['init'], { cwd: SYNC_DIR });
  }
  const remote = getRemote();
  if (remote) {
    const existing = git(['remote', 'get-url', 'origin'], { cwd: SYNC_DIR, ignoreError: true });
    if (existing.status !== 0) git(['remote', 'add', 'origin', remote]);
    else if (existing.stdout.trim() !== remote) git(['remote', 'set-url', 'origin', remote]);
  }
  _syncRepoReady = true;
  return SYNC_DIR;
}

export function isSyncSetup() {
  return existsSync(SYNC_DIR) && existsSync(join(SYNC_DIR, '.git')) && hasKey() && getRemote();
}
