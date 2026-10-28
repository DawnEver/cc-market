// ai-lab.mjs — the review METHOD, its planner and its merge are ai-lab's (PLAN-a-short-robust-toolchain
// P4): `python -m ai_lab.review.plan` and `python -m ai_lab.review.merge`, a JSON document on stdin and
// one on stdout. sharp-review keeps no method data and no method logic. The interpreter is the one
// fabric's setup pinned in the provider cache (`provider-cache.json` next to the cc-market registry); an
// absent cache, interpreter or ai-lab is an AiLabUnavailable naming the remedy — never a fallback.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { spawnSync as spawnHidden } from '../../shared/spawn.mjs';

// Every Python child speaks UTF-8: on Windows its stdio otherwise defaults to the console code page
// (cp1252), and a plan carrying "≥" dies with UnicodeEncodeError.
const PY_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const spawnSync = (cmd, args, opts = {}) => spawnHidden(cmd, args, { ...opts, env: { ...(opts.env ?? process.env), ...PY_ENV } });

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

// One `python -m <module> [args]` run: *doc* as JSON on stdin, the JSON it prints on stdout.
function runModule(module, doc, python, args = []) {
  const done = spawnSync(python, ['-m', module, ...args], { input: JSON.stringify(doc), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (done.error) throw new AiLabUnavailable(`Python ${python} cannot be started (${done.error.message}); run \`${SETUP_REMEDY}\``);
  if (done.status !== 0) throw moduleFailure(module, done, python);
  return JSON.parse(done.stdout);
}

/** The plan of one run: *request* ({manifest, run_id, started_at, date, seed, config?, sources?, ...}) planned by ai-lab. */
export function planRun(request, { python = aiLabPython(), rules = projectRuleIds(), principles = projectPrinciples() } = {}) {
  return runModule('ai_lab.review.plan', request, python, ['--rules', rules, '--principles', principles]);
}

/**
 * The registry rule ids of the project at *root*, comma-separated: the CALLER owns them (ai-lab imports no
 * registry). A dev-lab family repo answers through its own interpreter (`dev_lab.dev.rules.RULES`, the one
 * source); any other project has none, and `''` says so -- the review then cites principles alone.
 */
export function projectRuleIds(root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const python = projectPython(root);
  if (!python) return '';
  const done = spawnSync(python, ['-c', "from dev_lab.dev.rules import RULES; print(','.join(r.id for r in RULES))"],
    { cwd: root, encoding: 'utf8' });
  return done.status === 0 ? done.stdout.trim() : '';
}

// ai-lab's interpreter if the provider cache names one, else none (projectPrinciples' fallback never throws).
function cachedAiLabPython() {
  try { return aiLabPython(); } catch { return undefined; }
}

function projectPython(root) {
  return ['.venv/Scripts/python.exe', '.venv/bin/python'].map((rel) => join(root, rel)).find((p) => existsSync(p));
}

/**
 * A JSON file of the project's PRINCIPLES, for `--principles`: the CALLER owns them (ai-lab keeps no list).
 * A dev-lab family repo answers through its own interpreter (`python -m dev_lab.dev.principles --json`, the
 * one source); any other project reads the family's through ai-lab's interpreter, and where neither carries
 * dev-lab `{"principles": []}` says so.
 */
export function projectPrinciples(root = process.env.CLAUDE_PROJECT_DIR || process.cwd(), { fallback = cachedAiLabPython() } = {}) {
  const text = [projectPython(root), fallback].filter(Boolean).map((python) => {
    const done = spawnSync(python, ['-m', 'dev_lab.dev.principles', '--json'], { cwd: root, encoding: 'utf8' });
    return done.status === 0 && done.stdout.trim() ? done.stdout : null;
  }).find(Boolean) || '{"principles": []}';
  const file = join(mkdtempSync(join(tmpdir(), 'sharp-review-')), 'principles.json');
  writeFileSync(file, text);
  return file;
}

/** The findings JSON (v3) of *run* ({range, profiles, reviewers, results}) merged by ai-lab. */
export function mergeRun(run, { python = aiLabPython(), rules = projectRuleIds(), principles = projectPrinciples() } = {}) {
  return runModule('ai_lab.review.merge', run, python, ['--rules', rules, '--principles', principles]);
}

// The error a failed `-m <module>` run is: an ai-lab that is absent or older than the module is
// AiLabUnavailable naming the remedy; anything else (a `refused:` document) is a plain Error.
export function moduleFailure(module, { status, stderr }, python) {
  const escaped = module.replace(/\./g, '\.');
  if (new RegExp(`No module named '?${escaped}`).test(stderr)) return new AiLabUnavailable(`the ai-lab in ${python} has no \`${module}\`; upgrade it: run \`${SETUP_REMEDY}\``);
  if (/No module named '?ai_lab/.test(stderr)) return new AiLabUnavailable(`ai-lab is not installed in ${python}; run \`${SETUP_REMEDY}\``);
  return new Error(`${module} exited ${status}: ${stderr.trim().slice(-500)}`);
}
