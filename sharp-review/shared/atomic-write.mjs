// shared/atomic-write.mjs — whole-file writes that concurrent processes cannot tear.
//
// The temp name is unique per write (pid + random), so two writers never share a
// temp file; rename is atomic on one volume, so a reader sees the old bytes or the
// new bytes, never a mix. On Windows a rename onto a file another process holds
// open can fail transiently (EPERM/EBUSY): retry with a growing pause, then throw.
// Whatever fails, the temp file is removed: a failed write leaves no partial file.

import { writeFileSync, renameSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function atomicWriteFile(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, payload, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, file); return; }
      catch (err) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        pause(10 * 2 ** attempt); // 10, 20, 40, 80 ms
      }
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }
}

// Write only when the bytes differ. For a file DERIVED from other files: every
// writer computes the same payload, so an unchanged file is never touched and a
// race between two writers ends with the same bytes either way. Returns true on write.
export function writeIfChanged(file, payload) {
  let current = null;
  try { current = readFileSync(file, 'utf8'); } catch { /* absent */ }
  if (current === payload) return false;
  atomicWriteFile(file, payload);
  return true;
}
