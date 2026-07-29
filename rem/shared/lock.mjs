// shared/lock.mjs — cross-process lease lock via exclusive-create lockfile
// Guards read-modify-write sections of shared mutable files (.rem-state.json,
// _meta.json, MEMORY.md) against concurrent hook/script runs on both hosts.
// Pure Node, sync API (matches the sync fs style of state.mjs / stamp.mjs).
//
// Acquire: fs.open(lockPath + '.lock', 'wx') writing pid+timestamp.
// EEXIST: steal the lock if older than staleMs (crashed holder), else retry with
// backoff until timeoutMs — then proceed WITHOUT the lock (warn) rather than hang:
// a lock is a best-effort guard, never a reason to block a hook indefinitely.
// Release: unlink in a finally, so a throwing fn never leaves the lock held.

import { openSync, closeSync, writeSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Lockfiles this process currently holds — makes withLock reentrant per path,
// so an outer critical section can call helpers that lock the same resource.
const HELD = new Set();

function sleepMs(ms) {
  // Sync sleep without spawning a child (host-agnostic, no windowsHide concern).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(lockPath, fn, { staleMs = 60000, retryMs = 50, timeoutMs = 5000 } = {}) {
  const file = lockPath + '.lock';
  if (HELD.has(file)) return fn();

  let fd = null;
  const deadline = Date.now() + timeoutMs;
  while (fd === null) {
    try {
      fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Lockfile parent dir doesn't exist yet (e.g. rules/ before first index)
        mkdirSync(dirname(file), { recursive: true });
        continue;
      }
      if (err.code !== 'EEXIST') throw err;
      let mtime;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue; // holder released between open and stat — retry immediately
      }
      if (Date.now() - mtime > staleMs) {
        try { unlinkSync(file); } catch { /* another stealer won — retry */ }
        continue;
      }
      if (Date.now() >= deadline) {
        console.warn(`[lock] could not acquire ${file} within ${timeoutMs}ms — proceeding without lock`);
        return fn();
      }
      sleepMs(retryMs);
    }
  }

  HELD.add(file);
  try {
    return fn();
  } finally {
    HELD.delete(file);
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(file); } catch { /* stolen or already gone */ }
  }
}
