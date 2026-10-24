// ai-lab.mjs — the method's merge is ai-lab's: `python -m ai_lab.review.merge --method <dir>`.
// sharp-review keeps no merge of its own. The interpreter is the one fabric's setup pinned in the
// provider cache (`provider-cache.json` next to the cc-market registry); an absent cache, interpreter
// or ai-lab is an AiLabUnavailable naming the remedy — never a fallback.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { spawnSync } from '../../shared/spawn.mjs';

export const SETUP_REMEDY = 'node scripts/setup/setup.js (fabric setup: installs ai-lab and pins its interpreter)';

export class AiLabUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiLabUnavailable';
  }
}

/** The provider cache: next to `CC_MARKET_CONFIG_PATH`, else ~/.claude/provider-cache.json. */
export function providerCachePath(env = process.env) {
  const registry = env.CC_MARKET_CONFIG_PATH || join(homedir(), '.claude', 'claude_env_settings.json');
  return join(dirname(registry), 'provider-cache.json');
}

/** The interpreter ai-lab is installed in, as the provider cache records it. */
export function aiLabPython(cachePath = providerCachePath()) {
  if (!existsSync(cachePath)) throw new AiLabUnavailable(`no provider cache at ${cachePath}; run \`${SETUP_REMEDY}\``);
  const { python } = JSON.parse(readFileSync(cachePath, 'utf8'));
  if (!python) throw new AiLabUnavailable(`provider cache ${cachePath} records no Python interpreter; run \`${SETUP_REMEDY}\``);
  if (!existsSync(python)) throw new AiLabUnavailable(`Python ${python} (recorded in ${cachePath}) is not installed; run \`${SETUP_REMEDY}\``);
  return python;
}

/** The findings JSON of *run* ({range, date, profiles, reviewers, results}) merged by ai-lab against *method*. */
export function mergeRun(run, method, { python = aiLabPython() } = {}) {
  const done = spawnSync(python, ['-m', 'ai_lab.review.merge', '--method', method.dir], {
    input: JSON.stringify(run), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (done.error) throw new AiLabUnavailable(`Python ${python} cannot be started (${done.error.message}); run \`${SETUP_REMEDY}\``);
  if (done.status !== 0) throw mergeFailure(done, python);
  return JSON.parse(done.stdout);
}

// The error a failed `-m ai_lab.review.merge` run is: an ai-lab that is absent or older than the merge
// module is AiLabUnavailable naming the remedy; anything else (a `refused:` record) is a plain Error.
export function mergeFailure({ status, stderr }, python) {
  if (/No module named '?ai_lab\.review\.merge/.test(stderr)) return new AiLabUnavailable(`the ai-lab in ${python} has no \`ai_lab.review.merge\`; upgrade it: run \`${SETUP_REMEDY}\``);
  if (/No module named '?ai_lab/.test(stderr)) return new AiLabUnavailable(`ai-lab is not installed in ${python}; run \`${SETUP_REMEDY}\``);
  return new Error(`ai_lab.review.merge exited ${status}: ${stderr.trim().slice(-500)}`);
}
