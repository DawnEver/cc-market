// shared/spawn-child.mjs — L1 session fabric primitive. Launch a headless child model
// session (`claude -p`) for any provider, optionally behind the observe proxy.
//
// The `observe` boolean is the whole design in one switch:
//   observe:false → provider env direct (DeepSeek via Foundry). No capture, no overhead.
//   observe:true  → strip all provider routing, point ANTHROPIC_BASE_URL at a local
//                   observe proxy; the proxy owns the real upstream/auth/model. This is
//                   what makes DeepSeek traffic capturable despite Foundry.
//
// Headless (child_process, no PTY) is deliberate: it's the clean orchestration path from
// the design (structured I/O, no TTY question-guessing). Persistent interactive PTY
// sessions are a separate subsystem (see fabric/README roadmap).

import { loadProviderEnv, PROVIDER_ENV_KEYS } from './providers.mjs';
import { startObserveProxy } from './observe-proxy.mjs';
import { spawn as hiddenSpawn } from './spawn.mjs';

/**
 * Pure env-shaping — the error-prone core, unit-tested in isolation.
 * @returns {object} the child's environment.
 */
export function buildChildEnv({ provider, observe, proxyUrl, configPath }) {
  const env = loadProviderEnv(provider, configPath);
  if (!observe) return env; // normal: direct-connect (Foundry vars intact for deepseek)

  if (!proxyUrl) throw new Error('buildChildEnv: observe mode requires proxyUrl');
  // Route through the proxy with vanilla Anthropic vars only. Strip every provider key
  // (incl. Foundry) so nothing bypasses the proxy; the proxy injects the real upstream key.
  for (const k of PROVIDER_ENV_KEYS) delete env[k];
  env.ANTHROPIC_BASE_URL = proxyUrl;
  env.ANTHROPIC_AUTH_TOKEN = 'fabric-observe-placeholder';
  return env;
}

/**
 * Spawn a headless child session and collect its output.
 * @param {object} opts
 * @param {string}  opts.provider        registry key ('deepseek', 'claude', ...)
 * @param {string}  opts.prompt          the task prompt (claude -p)
 * @param {string}  opts.runDir          isolated dir (config + http.jsonl land here)
 * @param {boolean} [opts.observe]       route through the observe proxy + capture jsonl
 * @param {string}  [opts.model]         Claude model id (proxy remaps it per provider)
 * @param {string}  [opts.cwd]           child working dir (default runDir)
 * @param {string[]}[opts.extraArgs]     extra claude CLI args
 * @param {string}  [opts.configPath]    override registry path
 * @param {number}  [opts.timeoutMs]     kill after this long (default 120000)
 * @param {Function}[opts._spawn]        injectable spawn (tests)
 * @param {string}  [opts._bin]          override the child binary (tests)
 * @returns {Promise<{code, stdout, stderr, jsonlPath, runDir}>}
 */
export async function spawnChild(opts) {
  const {
    provider, prompt, runDir, observe = false, model,
    cwd, extraArgs = [], configPath, timeoutMs = 120000,
    _spawn = hiddenSpawn, _bin,
  } = opts;
  if (!provider) throw new Error('spawnChild: provider is required');
  if (!runDir) throw new Error('spawnChild: runDir is required');

  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(runDir, { recursive: true });
  const configDir = join(runDir, 'config');
  mkdirSync(configDir, { recursive: true });

  let proxy = null;
  if (observe) proxy = await startObserveProxy({ provider, runDir, configPath });

  try {
    const env = {
      ...buildChildEnv({ provider, observe, proxyUrl: proxy?.url, configPath }),
      CLAUDE_CONFIG_DIR: configDir,
    };

    const bin = _bin || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
    const args = ['-p', prompt, ...(model ? ['--model', model] : []), ...extraArgs];

    const result = await new Promise((resolve, reject) => {
      const child = _spawn(bin, args, { cwd: cwd || runDir, env });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`spawnChild: timeout after ${timeoutMs}ms`)); }, timeoutMs);
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });

    return { ...result, jsonlPath: proxy?.jsonlPath ?? null, runDir };
  } finally {
    if (proxy) await proxy.close();
  }
}
