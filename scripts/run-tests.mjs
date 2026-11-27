// The complete JS suite, the ONE list (pyproject [tool.lab_commons.tests], the Makefile and release.sh run this).
// It runs with TMP/TEMP/TMPDIR pointed at one fresh, empty directory and refuses the run if anything is left in
// it: the full-suite proof that tests reclaim every temp entry they make (through tests/temp-dir.mjs), including
// the ones made by the scripts they spawn, which inherit the env.
// rem/ is ARCHIVED (R16): an archived plugin is neither installed nor tested, so its tests are not in the suite.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUITE = [
  'fabric/tests/*.test.mjs', 'sharp-review/tests/*.test.mjs', 'evolve/tests/*.test.mjs',
  'shared/tests/*.test.mjs', 'tests/*.test.mjs',
];

/** Run `node --test <files>` against a private temp root; return its exit status and what it left behind. */
export function runSuite(files, { base = tmpdir(), stdio = 'inherit', cwd = process.cwd() } = {}) {
  const root = mkdtempSync(join(base, 'cc-market-suite-'));
  // NODE_TEST_CONTEXT would make a nested `node --test` (this runner under test) report to its parent, not run.
  const { NODE_TEST_CONTEXT, ...inherited } = process.env;
  const env = { ...inherited, TMP: root, TEMP: root, TMPDIR: root };
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { stdio, env, cwd, encoding: 'utf8' });
  const left = readdirSync(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { status: run.status ?? 1, left, stdout: run.stdout ?? '' };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const { status, left } = runSuite(args.length ? args : SUITE);
  if (left.length) {
    console.error(`TEMP-LEAK: the run left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temp root: `
      + `${left.slice(0, 20).join(', ')}${left.length > 20 ? ', ...' : ''}.\n`
      + 'Make each temp directory with tempDir() from tests/temp-dir.mjs (it is removed at exit); '
      + 'a script under test that makes one must remove it itself.');
    process.exit(1);
  }
  process.exit(status);
}
