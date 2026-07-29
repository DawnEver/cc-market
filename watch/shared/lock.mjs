// shared/lock.mjs — cross-process lease lock via exclusive-create lockfile
// Guards read-modify-write sections of shared mutable files (.rem-state.json,
// _meta.json, MEMORY.md) against concurrent hook/script runs on both hosts.
// Pure Node, sync API (matches the sync fs style of state.mjs / stamp.mjs).
//
// Acquire: fs.open(lockFilePath(lockPath), 'wx') writing {pid, at, token}.
// EEXIST: steal the lock if older than staleMs (crashed holder), else retry with
// backoff until timeoutMs. Timeout policy is caller-chosen ({ onTimeout }):
//   'throw'   (default) — mutating CLI scripts fail CLOSED with LockTimeoutError
//   'proceed'           — hooks warn and run without the lock (never block a hook)
// Release: unlink ONLY if the lockfile still carries our token — a lock stolen
// while held (staleMs exceeded) belongs to the stealer and must not be deleted.
//
// Lockfiles live in a DEVICE-LOCAL dir (os.tmpdir()/rem-locks/<hash>.lock), not
// next to the guarded file: guarded files sit in OneDrive-synced dirs, and a
// synced lockfile would falsely muteX across HOSTS. Data files stay synced;
// only the .lock moves.
//
// Lease renewal: while held, the lockfile mtime is refreshed every staleMs/3
// (unref'd interval, for async holders) AND synchronously on every subsequent
// withLock acquisition in the same process (for sync holders like prune whose
// event loop is blocked — the interval cannot fire mid-section).

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync, mkdirSync, utimesSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { createHash, randomBytes } from 'crypto';

// Atomics.wait throws on Node's main thread — detect once. When unavailable we
// cannot sleep synchronously, so contention resolution falls through to the
// timeout path after a couple of cheap iterations instead of hot-spinning.
const CAN_WAIT = (() => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); return true; }
  catch { return false; }
})();

export class LockTimeoutError extends Error {
  constructor(file, timeoutMs) {
    super(`[lock] could not acquire ${file} within ${timeoutMs}ms`);
    this.code = 'LOCK_TIMEOUT';
  }
}

// Device-local lockfile location for a guarded path. Exported for tests and
// for diagnostics — callers always pass the GUARDED path to withLock.
export function lockFilePath(lockPath) {
  const hash = createHash('sha256').update(resolve(lockPath)).digest('hex').slice(0, 16);
  return join(tmpdir(), 'rem-locks', hash + '.lock');
}

// Locks this process currently holds: file → { fd, token, timer }. Makes
// withLock reentrant per path, so an outer critical section can call helpers
// that lock the same resource.
const HELD = new Map();

function sleepMs(ms) {
  // Sync sleep without spawning a child (host-agnostic, no windowsHide concern).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Synchronous lease renewal: every lock acquisition refreshes the mtime of
// every lock this process holds, so a long critical section that keeps doing
// locked work (e.g. prune's per-file meta writes) never looks stale.
function renewHeld() {
  const now = new Date();
  for (const file of HELD.keys()) {
    try { utimesSync(file, now, now); } catch { /* gone — release copes */ }
  }
}

export function withLock(lockPath, fn, { staleMs = 60000, retryMs = 50, timeoutMs = 5000, onTimeout = 'throw' } = {}) {
  const file = lockFilePath(lockPath);
  if (HELD.has(file)) return fn(); // reentrant

  renewHeld();
  mkdirSync(dirname(file), { recursive: true });

  let fd = null;
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  let noSleepTries = 0;
  // True once we can neither sleep nor afford another cheap retry.
  const giveUp = () => Date.now() >= deadline || (!CAN_WAIT && ++noSleepTries >= 3);

  while (fd === null) {
    try {
      fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let mtime;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        // Holder released between open and stat — bounded backoff, then retry.
        if (giveUp()) break;
        if (CAN_WAIT) sleepMs(retryMs);
        continue;
      }
      if (Date.now() - mtime > staleMs) {
        try { unlinkSync(file); } catch { /* another stealer won — retry */ }
        continue;
      }
      if (giveUp()) break;
      if (CAN_WAIT) sleepMs(retryMs);
    }
  }

  if (fd === null) {
    if (onTimeout === 'proceed') {
      console.warn(`[lock] could not acquire ${file} within ${timeoutMs}ms — proceeding without lock`);
      return fn();
    }
    throw new LockTimeoutError(file, timeoutMs);
  }

  // Lease renewal for async holders: refresh mtime every staleMs/3 while held.
  // Unref'd so it never keeps a process alive; cleared in release.
  const timer = setInterval(() => {
    try { const now = new Date(); utimesSync(file, now, now); } catch { /* released */ }
  }, Math.max(100, Math.floor(staleMs / 3)));
  timer.unref?.();

  HELD.set(file, { fd, token });
  try {
    return fn();
  } finally {
    HELD.delete(file);
    clearInterval(timer);
    try { closeSync(fd); } catch { /* already closed */ }
    // Unlink only if the lock is still OURS — if it was stolen while held,
    // the lockfile now belongs to the stealer and must survive our release.
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8'));
      if (cur.token === token) unlinkSync(file);
    } catch { /* stolen or already gone */ }
  }
}
