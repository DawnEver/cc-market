// engine/open-session.mjs — L1 PERSISTENT multi-turn child session (library-level; no
// daemon). Holds one long-lived `claude` process speaking stream-json, so an orchestrator
// (a case, a workflow, a script) can carry a real multi-turn conversation with each child
// and fan out many concurrently. Context is retained across turns within the process
// (validated: two stdin messages, turn 2 recalls turn 1).
//
// Why stream-json over PTY: turns and tool/permission/question events arrive as structured
// JSON, not TTY text to scrape — the clean path from the harness-as-fabric design.
// Composes with observe via the same buildChildEnv switch as spawnChild.

import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChildEnv, hookFreeArgs, resolveClaudeExe, effortEnv } from './spawn-child.mjs';
import { startObserveProxy } from './observe-proxy.mjs';
import { applyProfileEnv, profileArgs, stripProfileOwnedFlags } from './profile.mjs';
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
    visible = false, interactive = false, effort = null,
    _spawn = hiddenSpawn, _bin, _viewerSpawn = hiddenSpawn, _pollMs = 400,
  } = opts;
  const showUi = visible || interactive; // interactive implies the transcript viewer
  if (!provider) throw new Error('openSession: provider is required');
  if (!runDir) throw new Error('openSession: runDir is required');

  mkdirSync(runDir, { recursive: true });
  const configDir = join(runDir, 'config');
  mkdirSync(configDir, { recursive: true });

  const proxy = observe ? await startObserveProxy({ provider, runDir, configPath }) : null;
  // Profile (G2): env subtraction and tool/permission flags attach HERE — the spawn point.
  // NATIVE claude authenticates via the user's real config dir (OAuth credentials) — the
  // isolation override would log every native session out. API providers auth via env
  // vars, so they keep the isolated dir.
  const configOverride = provider === 'claude' ? {} : { CLAUDE_CONFIG_DIR: configDir };
  const env = applyProfileEnv(
    { ...buildChildEnv({ provider, observe, proxyUrl: proxy?.url, configPath }), ...effortEnv(effort), ...configOverride },
    profile,
  );
  // resolveClaudeExe, never a `.cmd` shim: Node ≥20.12 rejects .cmd without shell:true
  // (spawn EINVAL), which silently broke every Windows persistent session.
  const bin = _bin || resolveClaudeExe();
  const args = [
    // --verbose is REQUIRED by the CLI for --print + stream-json output (exit 1 without);
    // the parser ignores the extra system events it adds.
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(model ? ['--model', model] : []), ...hookFreeArgs(extraArgs),
    // Profile flags come LAST and profile-owned flags are stripped from extraArgs —
    // otherwise "last flag wins" lets a caller override the policy (sharp-review SR-017).
    ...(profile ? stripProfileOwnedFlags(extraArgs) : extraArgs), ...profileArgs(profile),
  ];

  const child = _spawn(bin, args, { cwd: cwd || runDir, env, stdio: ['pipe', 'pipe', 'pipe'] });

  // Visible terminal (opt-in, default hidden): the protocol pipes stay untouched; each
  // turn is teed to a transcript file and a real console window tails it on THIS machine
  // (for a remote session, that is the peer's desktop). Closing the window is harmless —
  // it is a viewer, never the session.
  const transcriptPath = join(runDir, 'transcript.log');
  const inboxPath = join(runDir, 'inbox.txt');
  const tee = (line) => { try { appendFileSync(transcriptPath, line); } catch { /* viewer only */ } };
  if (showUi) {
    try {
      writeFileSync(transcriptPath, `[fabric ${provider}${model ? `/${model}` : ''}] session transcript — viewer window; closing it does NOT stop the session\n`);
      if (process.platform === 'win32' && !interactive) {
        // UTF-8 on both ends: the transcript is UTF-8 and the console must both decode
        // and render it, or em-dashes come out as GBK mojibake (observed 2026-08-09).
        _viewerSpawn('cmd', ['/c', 'start', `fabric ${provider}`, 'powershell', '-NoExit', '-Command',
          `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -LiteralPath '${transcriptPath}' -Wait -Tail 100 -Encoding UTF8`], { stdio: 'ignore', detached: true });
      } else if (process.platform !== 'win32') {
        process.stderr.write(`fabric: visible terminal not implemented on ${process.platform}; transcript at ${transcriptPath}\n`);
      }
    } catch { /* the viewer must never break the session */ }
  }

  // Interactive interjection: the human is ANOTHER SENDER, not the stdin owner. ONE chat
  // window shows the streaming transcript AND takes typed lines (non-blocking key polling);
  // each Enter lands the line in the inbox, and the engine injects it through the SAME
  // serialized send chain the orchestrator uses, so both drive one conversation and
  // neither can corrupt a turn in flight.
  let inboxTimer = null;
  let inboxOffset = 0;
  if (interactive) {
    try {
      writeFileSync(inboxPath, '');
      if (process.platform === 'win32') {
        const chatPs1 = join(runDir, 'chat.ps1');
        writeFileSync(chatPs1, `param([string]$Transcript, [string]$Inbox)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = New-Object Text.UTF8Encoding $false
Write-Host "fabric chat - transcript streams here; type and press Enter to interject. Closing this window does NOT stop the session." -ForegroundColor Cyan
$off = 0; $line = ''
while ($true) {
  try {
    $fs = [IO.File]::Open($Transcript, 'Open', 'Read', 'ReadWrite')
    if ($fs.Length -gt $off) {
      $fs.Position = $off
      $buf = New-Object byte[] ($fs.Length - $off)
      [void]$fs.Read($buf, 0, $buf.Length)
      $off = $fs.Length
      Write-Host -NoNewline $utf8.GetString($buf)
    }
    $fs.Close()
  } catch {}
  while ([Console]::KeyAvailable) {
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq 'Enter') {
      Write-Host ''
      if ($line.Trim()) { [IO.File]::AppendAllText($Inbox, $line + "\`n", $utf8) }
      $line = ''
    } elseif ($k.Key -eq 'Backspace') {
      if ($line.Length) { $line = $line.Substring(0, $line.Length - 1); Write-Host -NoNewline "\`b \`b" }
    } elseif ($k.KeyChar) { $line += $k.KeyChar; Write-Host -NoNewline $k.KeyChar -ForegroundColor Yellow }
  }
  Start-Sleep -Milliseconds 150
}
`);
        _viewerSpawn('cmd', ['/c', 'start', `fabric ${provider} chat`, 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass',
          '-File', chatPs1, '-Transcript', transcriptPath, '-Inbox', inboxPath], { stdio: 'ignore', detached: true });
      }
    } catch { /* chat UI must never break the session */ }
    inboxTimer = setInterval(() => {
      try {
        const raw = readFileSync(inboxPath, 'utf8');
        if (raw.length <= inboxOffset) return;
        const chunk = raw.slice(inboxOffset);
        const lastNl = chunk.lastIndexOf('\n');
        if (lastNl === -1) return; // no complete line yet
        inboxOffset += lastNl + 1;
        for (const line of chunk.slice(0, lastNl).split('\n')) {
          const text = line.replace(/^﻿/, '').trim();
          if (text) send(text, 'human').catch((e) => tee(`\n[error] human turn failed: ${e.message}\n`));
        }
      } catch { /* inbox gone: viewer closed, nothing to inject */ }
    }, _pollMs);
    inboxTimer.unref?.();
  }

  let turnCount = 0;
  let pending = null;        // { resolve, reject, text }
  let acc = '';              // assistant text accumulator for the in-flight turn
  let closed = false;
  let exitCode = null;
  let chain = Promise.resolve(); // serializes send() calls
  let buf = '';
  let lastActivity = Date.now();
  let errTail = '';          // last stderr bytes — the only clue when the child dies
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 }; // cumulative (G7)

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
        usage.input_tokens += ev.usage?.input_tokens ?? 0;
        usage.output_tokens += ev.usage?.output_tokens ?? 0;
        usage.cost_usd += ev.total_cost_usd ?? 0;
        const p = pending; pending = null;
        const text = acc; acc = '';
        if (showUi) tee(`\n[assistant · turn ${turnCount}]\n${text}\n`);
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

  function send(text, _label = 'user') {
    // Serialize: each send waits for the previous turn's result — orchestrator and
    // human turns share this one chain.
    const run = () => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('openSession: session is closed'));
      pending = { resolve, reject };
      lastActivity = Date.now();
      if (showUi) tee(`\n[${_label}]\n${text}\n`);
      child.stdin.write(userLine(text));
    });
    chain = chain.then(run, run);
    return chain;
  }

  async function close() {
    if (inboxTimer) { clearInterval(inboxTimer); inboxTimer = null; }
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
    get usage() { return { ...usage } },
    send, close,
  };
}
