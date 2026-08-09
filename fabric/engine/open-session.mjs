// engine/open-session.mjs — L1 PERSISTENT multi-turn child session (library-level; no
// daemon). Holds one long-lived `claude` process speaking stream-json, so an orchestrator
// (a case, a workflow, a script) can carry a real multi-turn conversation with each child
// and fan out many concurrently. Context is retained across turns within the process
// (validated: two stdin messages, turn 2 recalls turn 1).
//
// Why stream-json over PTY: turns and tool/permission/question events arrive as structured
// JSON, not TTY text to scrape — the clean path from the harness-as-fabric design.
// Composes with observe via the same buildChildEnv switch as spawnChild.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildChildEnv, hookFreeArgs, resolveClaudeExe } from './spawn-child.mjs';
import { startObserveProxy } from './observe-proxy.mjs';
import { applyProfileEnv, profileArgs } from './profile.mjs';
import { spawn as hiddenSpawn } from '../shared/spawn.mjs';

const STDERR_TAIL_BYTES = 4096;
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

function extractText(assistantMsg) {
  const c = assistantMsg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('');
  return '';
}

/**
 * Open a persistent child session.
 * @param {object} opts  provider, model?, observe?, runDir, cwd?, configPath?, extraArgs?
 *                       _spawn?/_bin? for tests.
 * @returns {Promise<{runDir, jsonlPath, send, close, turns}>}
 *   send(text) → Promise<{text, turn}>  (await sequentially; one turn at a time)
 *   close()    → Promise<number|null>   (exit code)
 */
export async function openSession(opts) {
  const {
    provider, model, observe = false, runDir, cwd, configPath, extraArgs = [], profile = null,
    _spawn = hiddenSpawn, _bin,
  } = opts;
  if (!provider) throw new Error('openSession: provider is required');
  if (!runDir) throw new Error('openSession: runDir is required');

  mkdirSync(runDir, { recursive: true });
  const configDir = join(runDir, 'config');
  mkdirSync(configDir, { recursive: true });

  const proxy = observe ? await startObserveProxy({ provider, runDir, configPath }) : null;
  // Profile (G2): env subtraction and tool/permission flags attach HERE — the spawn point.
  const env = applyProfileEnv(
    { ...buildChildEnv({ provider, observe, proxyUrl: proxy?.url, configPath }), CLAUDE_CONFIG_DIR: configDir },
    profile,
  );
  // resolveClaudeExe, never a `.cmd` shim: Node ≥20.12 rejects .cmd without shell:true
  // (spawn EINVAL), which silently broke every Windows persistent session.
  const bin = _bin || resolveClaudeExe();
  const args = [
    // --verbose is REQUIRED by the CLI for --print + stream-json output (exit 1 without);
    // the parser ignores the extra system events it adds.
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(model ? ['--model', model] : []), ...profileArgs(profile), ...hookFreeArgs(extraArgs), ...extraArgs,
  ];

  const child = _spawn(bin, args, { cwd: cwd || runDir, env, stdio: ['pipe', 'pipe', 'pipe'] });

  let turnCount = 0;
  let pending = null;        // { resolve, reject, text }
  let acc = '';              // assistant text accumulator for the in-flight turn
  let closed = false;
  let exitCode = null;
  let chain = Promise.resolve(); // serializes send() calls
  let buf = '';
  let lastActivity = Date.now();
  let errTail = '';          // last stderr bytes — the only clue when the child dies

  child.stderr?.on('data', (d) => {
    errTail = (errTail + d).slice(-STDERR_TAIL_BYTES);
  });

  child.stdout?.on('data', (d) => {
    lastActivity = Date.now();
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') acc += extractText(ev.message);
      else if (ev.type === 'result') {
        turnCount++;
        const p = pending; pending = null;
        const text = acc; acc = '';
        if (p) p.resolve({ text, turn: turnCount });
      }
    }
  });

  child.on('close', (code) => {
    closed = true; exitCode = code;
    if (pending) {
      const tail = errTail.trim() ? `; stderr: ${errTail.trim()}` : '';
      pending.reject(new Error(`openSession: child closed (code ${code}) mid-turn${tail}`));
      pending = null;
    }
  });
  child.on('error', (e) => {
    closed = true;
    if (pending) { pending.reject(e); pending = null; }
  });

  function send(text) {
    // Serialize: each send waits for the previous turn's result.
    const run = () => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('openSession: session is closed'));
      pending = { resolve, reject };
      lastActivity = Date.now();
      child.stdin.write(userLine(text));
    });
    chain = chain.then(run, run);
    return chain;
  }

  async function close() {
    if (!closed) {
      // Attach the close listener BEFORE ending stdin, else a fast exit can fire before
      // we're listening and we'd wait out the full fallback timeout.
      const done = new Promise((r) => child.on('close', r));
      let timer;
      const guard = new Promise((r) => { timer = setTimeout(r, 8000); });
      try { child.stdin.end(); } catch { /* already gone */ }
      await Promise.race([done, guard]);
      clearTimeout(timer); // else the pending timer keeps the event loop alive

    }
    if (proxy) await proxy.close();
    return exitCode;
  }

  return {
    runDir, jsonlPath: proxy?.jsonlPath ?? null,
    get turns() { return turnCount; },
    // Liveness facts (G3): reported, never inferred — the layer above decides what to do.
    pid: child.pid ?? null,
    get alive() { return !closed; },
    get lastActivity() { return lastActivity; },
    stderrTail: () => errTail,
    send, close,
  };
}
