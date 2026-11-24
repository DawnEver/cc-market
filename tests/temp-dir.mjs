// The ONE place a test makes a temp directory. Every directory it hands out is removed when the test process
// exits, so a suite run reclaims every one of them whether or not the test that made it cleans up itself.
// `tests/temp-dir.test.mjs` refuses `mkdtemp` / `tmpdir()` in a test anywhere else; `scripts/run-tests.mjs`
// proves a full run leaves nothing behind in the temp root.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();

/** A fresh directory `<base>/<prefix>XXXXXX` (base: the temp root), removed at process exit. */
export function tempDir(prefix = 'cc-market-test-', base = tmpdir()) {
  const dir = mkdtempSync(join(base, prefix));
  made.add(dir);
  return dir;
}

/** Remove every directory `tempDir` made so far (the exit hook calls it; a test may call it early). */
export function reclaimTempDirs() {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* reported by run-tests */ }
    made.delete(dir);
  }
}

process.on('exit', reclaimTempDirs);
