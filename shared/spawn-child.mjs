// shared/spawn-child.mjs — L1 session engine. Launch a headless child model session
// (`claude -p`) for any provider, optionally behind the observe proxy. The single
// implementation behind both fabric's `run_task` and takeover's claude/deepseek modes
// (previously two forks: fabric spawnChild + takeover spawnClaudeP).
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProviderEnv, loadProviderConfig, resolveModel, resolveModelFromId, PROVIDER_ENV_KEYS } from './providers.mjs';
import { startObserveProxy } from './observe-proxy.mjs';
import { buildUserContent } from './anthropic-http.mjs';
import { spawn as hiddenSpawn } from './spawn.mjs';

// ── Claude binary resolution (cross-platform) ───────────────────────────────

// On Windows, spawn(shell:false) cannot launch the `claude.cmd`/`claude.ps1`
// shims — it needs the real `claude.exe`. That .exe lives in the global npm
// prefix at node_modules/@anthropic-ai/claude-code/bin/claude.exe, but the
// prefix is install-specific (nvm4w → D:\nvm4w\nodejs, plain npm → ~\nodejs),
// so it cannot be hardcoded. Resolve it dynamically:
//   1. CLAUDE_CLI_PATH override (escape hatch)
//   2. derive from the launcher shim found on PATH
//   3. legacy ~/nodejs fallback
const CLAUDE_EXE_REL = path.join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

// Memoized: the PATH scan + fs.existsSync probes are pure per-process (keyed on the
// CLAUDE_CLI_PATH override so changing the env var still takes effect).
let _exeCache = null; // { override: string|undefined, exe: string }

export function clearClaudeExeCache() { _exeCache = null; }

export function resolveClaudeExe() {
  const override = process.env.CLAUDE_CLI_PATH;
  if (_exeCache && _exeCache.override === override) return _exeCache.exe;
  const exe = computeClaudeExe(override);
  _exeCache = { override, exe };
  return exe;
}

function computeClaudeExe(override) {
  if (override) return override;
  if (process.platform !== 'win32') return 'claude';

  // Find the directory of a claude shim on PATH; the npm global prefix (which
  // holds the shims) also contains node_modules with the real .exe.
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const shim of ['claude.cmd', 'claude.exe', 'claude.ps1', 'claude']) {
      if (fs.existsSync(path.join(dir, shim))) {
        const exe = path.join(dir, CLAUDE_EXE_REL);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return path.join(os.homedir(), 'nodejs', CLAUDE_EXE_REL); // legacy fallback
}

// ── Env shaping ──────────────────────────────────────────────────────────────

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

// ── Stream-json parsing (large prompts / images go via stdin) ────────────────

// Text carried by one stream-json message ('' if none) — the single extraction
// used by both parseStreamJsonOutput and the live onText handler.
// Duplicate rule: some providers' final `result` message repeats the full assistant
// text verbatim (observed with DeepSeek via Foundry) — a result equal to the
// accumulated assistant text must be dropped, or callers see the answer twice.
// Both consumers thread the accumulated assistant text in as `assistantAcc`.
function extractStreamText(msg, assistantAcc = '') {
  if (msg.type === 'assistant' && msg.message?.content) {
    let text = '';
    for (const block of (Array.isArray(msg.message.content) ? msg.message.content : [msg.message.content])) {
      if (block.type === 'text' || typeof block === 'string') {
        text += (typeof block === 'string' ? block : block.text || '');
      }
    }
    return text;
  }
  if (msg.type === 'result' && msg.result) {
    return msg.result.trim() === assistantAcc.trim() ? '' : msg.result;
  }
  return '';
}

export function parseStreamJsonOutput(raw) {
  const lines = raw.split('\n').filter((l) => l.trim());
  let text = '';
  let assistantAcc = '';
  let usage = null;
  let parsedAny = false; // a RECOGNIZED stream-json message seen (object with a string
  //                        .type) — distinguishes an empty model response from unparsable
  //                        output. JSON-shaped error bodies ({"error":...}) don't count,
  //                        so they still reach the caller via the raw-stdout fallback.
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') continue;
      parsedAny = true;
      const t = extractStreamText(msg, assistantAcc);
      text += t;
      if (msg.type === 'assistant') assistantAcc += t;
      if (msg.type === 'result' && msg.usage) usage = msg.usage;
    } catch {}
  }
  return { text: text.trim(), usage, parsedAny };
}

// Watchdog kill timer. The child_process `timeout` option is unusable here: on
// spawn ENOENT Node emits 'error' but never 'exit', so its internal kill timer
// is never cleared and keeps the event loop alive for the full timeout. This
// timer is unref'd (never blocks process exit) and explicitly cleared.
function armKillTimer(child, ms, onTimeout) {
  const t = globalThis.setTimeout(() => { try { child.kill('SIGKILL'); } catch {} onTimeout(); }, ms);
  t.unref?.();
  return t;
}

/**
 * Spawn a headless child session and collect its output.
 * @param {object} opts
 * @param {string}  [opts.provider]       registry key ('deepseek', 'claude', ...); default 'claude'
 * @param {string}  opts.prompt           the task prompt (claude -p)
 * @param {string}  [opts.systemPrompt]   prepended to the prompt ("sys\n\n---\n\nprompt")
 * @param {Array}   [opts.images]         [{media_type, data(base64)}] — forces stream-json stdin
 * @param {string}  [opts.runDir]         isolated dir (config + http.jsonl land here). Omit to
 *                                        run against the caller's own config/credentials.
 * @param {boolean} [opts.observe]        route through the observe proxy + capture jsonl (needs runDir)
 * @param {boolean} [opts.passthroughAuth] observe: forward the child's own Authorization header
 *                                        instead of injecting a static key. Defaults on for
 *                                        native OAuth providers (claude).
 * @param {string}  [opts.model]          Claude model id. Native/observe → --model flag;
 *                                        direct-connect API provider → exact env pin via resolveModel.
 * @param {string}  [opts.cwd]            child working dir (default runDir or cwd)
 * @param {string[]}[opts.extraArgs]      extra claude CLI args
 * @param {string}  [opts.configPath]     override registry path
 * @param {number}  [opts.timeoutMs]      kill after this long (default 120000)
 * @param {AbortSignal} [opts.signal]     cancel the child
 * @param {Function}[opts.onText]         streaming text callback (both stdin and argv modes)
 * @param {Function}[opts._spawn]         injectable spawn (tests)
 * @param {string}  [opts._bin]           override the child binary (tests)
 * @param {Function}[opts._startObserveProxy] injectable proxy starter (tests)
 * @returns {Promise<{code, stdout, stderr, usage, jsonlPath, runDir}>}
 */
export async function spawnChild(opts) {
  const {
    provider = 'claude', prompt, systemPrompt, images, runDir, observe = false, model,
    cwd, extraArgs = [], configPath, timeoutMs = 120000, signal, onText, passthroughAuth,
    _spawn = hiddenSpawn, _bin, _startObserveProxy = startObserveProxy,
  } = opts;
  if (!prompt) throw new Error('spawnChild: prompt is required');
  if (observe && !runDir) throw new Error('spawnChild: observe mode requires runDir');

  let configDir = null;
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    configDir = path.join(runDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
  }

  let proxy = null;
  if (observe) {
    // OAuth providers (native claude) have no static key to inject — the proxy must
    // forward the child's own self-refreshing Authorization header.
    const pta = passthroughAuth ?? !!loadProviderConfig(provider, configPath).native;
    proxy = await _startObserveProxy({ provider, runDir, passthroughAuth: pta, configPath });
  }

  try {
    const env = buildChildEnv({ provider, observe, proxyUrl: proxy?.url, configPath });
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const useStdin = fullPrompt.length > 1000 || (images && images.length > 0);

    // Model: the proxy remaps the request body (observe) and native claude takes the
    // flag; a direct-connect API provider gets an exact env pin instead — the flag
    // would depend on tier-alias env vars being present.
    const modelArgs = [];
    if (model) {
      const cfg = loadProviderConfig(provider, configPath);
      if (observe || cfg.native) {
        modelArgs.push('--model', model);
      } else {
        // Tier words + provider-native ids via resolveModel; full Claude ids by tier substring.
        env.ANTHROPIC_MODEL = /^claude-/i.test(model) ? resolveModelFromId(cfg, model) : resolveModel(cfg, model);
      }
    }

    const bin = _bin || resolveClaudeExe();
    // Both modes emit stream-json on stdout so usage parsing + onText streaming are
    // universal; argv mode just keeps the prompt on the command line.
    const args = useStdin
      ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', ...modelArgs, ...extraArgs]
      : ['-p', fullPrompt, '--output-format', 'stream-json', ...modelArgs, ...extraArgs];

    const result = await new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('spawnChild: request cancelled')); return; }

      const child = _spawn(bin, args, {
        cwd: cwd || runDir || process.cwd(),
        env,
        stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '', stderr = '', settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; cleanup(); fn(val); } };
      const onAbort = () => { try { child.kill('SIGTERM'); } catch {} settle(reject, new Error('spawnChild: request cancelled')); };
      const killTimer = armKillTimer(child, timeoutMs, () =>
        settle(reject, new Error(`spawnChild: timeout after ${timeoutMs}ms`)));
      const cleanup = () => {
        clearTimeout(killTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      let lineBuffer = '';
      let streamedAssistant = ''; // for the result-repeats-assistant dedupe (see extractStreamText)
      const emitLine = (line) => {
        try {
          const msg = JSON.parse(line);
          const text = extractStreamText(msg, streamedAssistant);
          if (msg?.type === 'assistant') streamedAssistant += text;
          if (text) onText(text);
        } catch {}
      };
      child.stdout?.on('data', (d) => {
        stdout += d;
        if (onText) {
          // Buffer partial lines: a JSON line can be split across chunk boundaries.
          lineBuffer += d.toString();
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop();
          for (const line of lines.filter((l) => l.trim())) emitLine(line);
        }
      });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (e) => settle(reject, e));
      child.on('close', (code) => {
        // Drain the tail: the last chunk may lack a trailing newline.
        if (onText && lineBuffer.trim()) emitLine(lineBuffer.trim());
        const parsed = parseStreamJsonOutput(stdout);
        // Non-NDJSON stdout (CLI usage errors, banners, gateway HTML) would otherwise be
        // silently dropped — fall back to the raw output when parsing yields no text.
        settle(resolve, { code, stdout: parsed.parsedAny ? parsed.text : stdout.trim(), stderr, usage: parsed.usage });
      });

      if (useStdin) {
        const content = buildUserContent(fullPrompt, images);
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
        child.stdin.end();
      }
    });

    return { ...result, jsonlPath: proxy?.jsonlPath ?? null, runDir: runDir ?? null };
  } finally {
    if (proxy) await proxy.close();
  }
}
