// engine/open-session.mjs — L1 PERSISTENT multi-turn child session (library-level; no
// daemon). Holds one long-lived `claude` process speaking stream-json, so an orchestrator
// (a case, a workflow, a script) can carry a real multi-turn conversation with each child
// and fan out many concurrently. Context is retained across turns within the process
// (validated: two stdin messages, turn 2 recalls turn 1).
//
// Why stream-json over PTY: turns and tool/permission/question events arrive as structured
// JSON, not TTY text to scrape — the clean path from the harness-as-fabric design.
// Composes with observe via the same buildChildEnv switch as spawnChild.

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { buildChildEnv, hookFreeArgs, resolveClaudeExe, effortEnv } from './spawn-child.mjs';
import { startObserveProxy } from './observe-proxy.mjs';
import { applyProfileEnv, profileArgs, stripProfileOwnedFlags } from './profile.mjs';
import { loadFabricConfig } from './node-config.mjs';
import { resolveStyleFile } from './style-resolve.mjs';
import { spawn as hiddenSpawn } from '../shared/spawn.mjs';

const STDERR_TAIL_BYTES = 4096;
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

// Env vars whose VALUE is a credential. The stderr tail flows into Error messages, MCP
// tool results and the journal (session.mjs journals e.message as the loss reason), and
// children routinely spill their env on a startup auth failure — so the tail is scrubbed
// at its source, where the child's own env is known (sharp-review SR-008).
const SECRET_KEY_RE = /TOKEN|KEY|SECRET|PASSWORD/i;
const MIN_SECRET_LEN = 6; // below this a "value" is a flag like "1", not a credential

function secretValuesOf(env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY_RE.test(k) && typeof v === 'string' && v.length >= MIN_SECRET_LEN)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length); // longest first: a prefix must not mask its superstring
}

// A runDir fabric minted for itself in the OS temp dir — the only kind close() may remove.
const FABRIC_TMP_DIR_RE = /^fabric-(session|call)-/;
function isFabricTmpDir(dir) {
  try {
    return resolve(dir).startsWith(resolve(tmpdir())) && FABRIC_TMP_DIR_RE.test(basename(dir));
  } catch { return false; }
}

// Sessions that crashed (or predate the cleanup) leave their runDir behind; sweep the
// stale ones once per process so tmp cannot grow without bound (SR-034).
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function gcStaleRunDirs(now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!FABRIC_TMP_DIR_RE.test(name)) continue;
      const p = join(tmpdir(), name);
      try {
        if (now - statSync(p).mtimeMs < GC_AGE_MS) continue;
        rmSync(p, { recursive: true, force: true });
        removed++;
      } catch { /* in use by another process, or already gone */ }
    }
  } catch { /* no readable tmpdir: nothing to reclaim */ }
  return removed;
}
if (!process.env.FABRIC_NO_TMP_GC) gcStaleRunDirs();

function extractText(assistantMsg) {
  const c = assistantMsg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('');
  return '';
}

/**
 * Open a persistent child session.
 * @param {object} opts  provider, model?, observe?, runDir, cwd?, configPath?, extraArgs?
 *                       ownsRunDir? (default: true for a fabric-minted tmp runDir),
 *                       _spawn?/_bin? for tests.
 * @returns {Promise<{runDir, jsonlPath, send, close, turns}>}
 *   send(text, label?, {timeoutMs}?) → Promise<{text, turn}>  (await sequentially)
 *   close()    → Promise<number|null>   (exit code)
 */
export async function openSession(opts) {
  const {
    provider, model, observe = false, runDir, cwd, configPath, extraArgs = [], profile = null,
    visible = false, interactive = false, effort = null, ownsRunDir, resume = null,
    _spawn = hiddenSpawn, _bin, _viewerSpawn = hiddenSpawn, _pollMs = 400,
  } = opts;
  // Only a directory fabric itself minted is ours to delete; a caller's runDir is not.
  const reclaimRunDir = ownsRunDir ?? isFabricTmpDir(runDir || '');
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
  // Platform default system prompt (fabric.systemPromptFile in the config) applies
  // when the profile does not name one — replaces the stock prompt on every spawn
  // (cache-key layer; combined with toolsPreset = full cost chain).
  const cfg = loadFabricConfig(configPath);
  // Priority: profile.systemPromptFile > profile.style (resolved from the
  // platform dir, auto-built) > cfg.systemPromptFile (platform default).
  let sysFile = profile?.systemPromptFile ?? null;
  if (!sysFile && profile?.style && cfg.systemPromptFile) {
    sysFile = resolveStyleFile(profile.style, cfg.systemPromptFile);
  }
  sysFile ??= cfg.systemPromptFile ?? null;
  const args = [
    // --verbose is REQUIRED by the CLI for --print + stream-json output (exit 1 without);
    // the parser ignores the extra system events it adds.
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    ...(model ? ['--model', model] : []),
    // Recovery (2026-08-10): resume restores a conversation from the CLI's session
    // store after serve crashed — the new child continues the old session's context.
    ...(resume ? ['--resume', resume] : []), ...hookFreeArgs(extraArgs),
    // Profile flags come LAST and profile-owned flags are stripped from extraArgs —
    // otherwise "last flag wins" lets a caller override the policy (sharp-review SR-017).
    ...(profile ? stripProfileOwnedFlags(extraArgs) : extraArgs), ...profileArgs(profile),
    // Platform default (last, so an explicit profile flag still wins by position). A MISSING
    // file is skipped with a warning — a prompt file is a policy layer, never a reason to
    // refuse the session (a machine that has not synced it must still be able to spawn).
    // Reproduced live 2026-08-11: fabric.systemPromptFile was absent on WS1, and the CLI
    // exited 1 at startup for every session there.
    ...(sysFile && !profile?.systemPromptFile && existsSync(sysFile) ? ['--system-prompt-file', sysFile] : []),
  ];
  if (sysFile && !profile?.systemPromptFile && !existsSync(sysFile)) {
    process.stderr.write(`fabric: system prompt file not found (skipping --system-prompt-file): ${sysFile}\n`);
  }

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
  let compactBoundaryAt = 0; // compact_boundary system events observed (native compaction)
  let sessionId = null;      // the CLI's own session id (init event) — enables --resume recovery
  let pending = null;        // { resolve, reject, text }
  let acc = '';              // assistant text accumulator for the in-flight turn
  let closed = false;
  // Goal mode (2026-08-10). The CLI's NATIVE /goal loop turned out unreachable in
  // fabric's child architecture — probed three ways: /goal refuses under the
  // hook-free policy (disableAllHooks), and enabling hooks on an isolated config dir
  // hangs the CLI at startup (real-dir children would fire the USER's hooks, which
  // the policy forbids). So the goal loop is FABRIC-SIDE: setGoal stores the
  // condition; goalRun sends the trigger with a completion-marker protocol
  // ("end your final reply with exactly <<GOAL_COMPLETE>>") and re-sends a
  // continuation until the marker appears, capped by maxTurns/timeout. Provider-
  // independent, works under the hook-free policy, honestly reported.
  let goalActive = false;
  let goalCondition = null;
  let goalRunning = false;   // a goal run in flight owns the conversation
  const DEFAULT_GOAL_MAX_TURNS = 20;
  const DEFAULT_GOAL_TIMEOUT_MS = 30 * 60 * 1000;
  const GOAL_MARKER = '<<GOAL_COMPLETE>>';
  let exitCode = null;
  let chain = Promise.resolve(); // serializes send() calls
  let buf = '';
  let lastActivity = Date.now();
  // Cumulative usage (G7). Cache tokens are usually the dominant input term, so a total
  // built on input_tokens alone under-counts by a growing fraction (SR-012); `partial`
  // records that at least one turn reported no usage at all.
  const usage = {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cost_usd: 0, partial: false,
  };
  // Current context-window fill, ESTIMATED — see the result handler for why the naive
  // "input + cache read" sum is a lie on tool-heavy turns. Reset per turn so a native
  // compact (compact_boundary) drops it on the next result (the "compact freed the
  // window" signal the console shows as a percentage drop).
  let contextTokens = 0;

  // Last stderr BYTES — the only clue when the child dies. Kept as Buffers: coercing each
  // chunk to a string decoded at an arbitrary boundary, tearing multibyte UTF-8, and made
  // the "BYTES" cap a character count (SR-008).
  const errChunks = [];
  let errBytes = 0;
  const secrets = secretValuesOf(env);
  const scrub = (text) => secrets.reduce((s, v) => s.split(v).join('[redacted]'), text);

  child.stderr?.on('data', (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
    errChunks.push(b);
    errBytes += b.length;
    while (errChunks.length > 1 && errBytes - errChunks[0].length >= STDERR_TAIL_BYTES) {
      errBytes -= errChunks.shift().length;
    }
  });

  function errTail() {
    if (!errChunks.length) return '';
    const text = Buffer.concat(errChunks).subarray(-STDERR_TAIL_BYTES).toString('utf8');
    // The cut itself can land mid-character; drop the one replacement char it produces.
    return scrub(text.startsWith('�') ? text.slice(1) : text);
  }

  child.stdout?.on('data', (d) => {
    lastActivity = Date.now();
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      // The CLI's own session id arrives on the init event — journaled so a crashed
      // serve can RESUME the conversation later (recovery: --resume <session_id>).
      if (ev.type === 'system' && ev.subtype === 'init') sessionId = ev.session_id ?? sessionId;
      else if (ev.type === 'assistant') acc += extractText(ev.message);
      else if (ev.type === 'system' && ev.subtype === 'compact_boundary') compactBoundaryAt++;
      else if (ev.type === 'result') {
        turnCount++;
        if (ev.usage) {
          usage.input_tokens += ev.usage.input_tokens ?? 0;
          usage.output_tokens += ev.usage.output_tokens ?? 0;
          usage.cache_creation_input_tokens += ev.usage.cache_creation_input_tokens ?? 0;
          usage.cache_read_input_tokens += ev.usage.cache_read_input_tokens ?? 0;
          // Window fill is a PER-REQUEST quantity, but the CLI's result usage is summed
          // over the turn's internal API sub-requests (every tool call re-reads the whole
          // cached prefix). input+cache_read therefore over-counts Nx on agentic turns —
          // live 2026-08-11: 932k "occupancy" reported for a 200k-window session that was
          // ~46% full (cache_read 1.25M cumulative across 3 turns of ~10 sub-requests).
          // cache_read IS the re-read term, so exclude it: fresh non-cached input (this
          // turn) + distinct content ever written to cache is a fair fill estimate that
          // works whether the provider caches (creation ≈ cached content) or not
          // (creation 0, input = whole prompt, correct either way).
          contextTokens = (ev.usage.input_tokens ?? 0) + usage.cache_creation_input_tokens;
        } else {
          usage.partial = true; // a turn we cannot account for — say so, do not imply zero
        }
        usage.cost_usd += ev.total_cost_usd ?? 0;
        const p = pending; pending = null;
        const text = acc; acc = '';
        tee(`\n[assistant · turn ${turnCount}]\n${text}\n`);
        if (p) p.resolve({ text, turn: turnCount });
      }
    }
  });

  child.on('close', (code) => {
    closed = true; exitCode = code;
    if (pending) {
      const t = errTail().trim();
      const tail = t ? `; stderr: ${t}` : '';
      pending.reject(new Error(`openSession: child closed (code ${code}) mid-turn${tail}`));
      pending = null;
    }
  });
  child.on('error', (e) => {
    closed = true;
    if (pending) { pending.reject(e); pending = null; }
  });

  /**
   * @param {number} [opts.timeoutMs] Per-turn deadline. Default: none — a turn may legitimately
   *   take many minutes. On expiry the child is KILLED and the session marked closed: a turn
   *   abandoned mid-flight leaves the conversation state unknowable, and leaving the child alive
   *   would let a late result answer the wrong caller while the serialized chain stays wedged
   *   (SR-052). Callers get code 'TURN_TIMEOUT'; later sends fail fast with "session is closed".
   */
  function sendRaw(text, _label = 'user', { timeoutMs } = {}) {
    // Serialize: each send waits for the previous turn's result — orchestrator and
    // human turns share this one chain.
    const run = () => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('openSession: session is closed'));
      let timer = null;
      const settle = (fn) => (v) => { if (timer) { clearTimeout(timer); timer = null; } fn(v); };
      const slot = { resolve: settle(resolve), reject: settle(reject) };
      pending = slot;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending !== slot) return; // already answered
          pending = null;
          closed = true;
          const e = new Error(`openSession: turn timed out after ${timeoutMs}ms`);
          e.code = 'TURN_TIMEOUT';
          try { child.kill?.('SIGKILL'); } catch { /* already gone */ }
          slot.reject(e);
        }, timeoutMs);
        timer.unref?.();
      }
      lastActivity = Date.now();
      // The transcript is ALWAYS recorded (not just for visible/interactive sessions):
      // session_view / node/view read it, so every session is inspectable from anywhere
      // in the fleet. The viewer WINDOW below stays opt-in via showUi.
      tee(`\n[${_label}]\n${text}\n`);
      child.stdin.write(userLine(text));
    });
    chain = chain.then(run, run);
    return chain;
  }

  /**
   * Set (or replace) the session's goal. Local state only — the goal loop is
   * fabric-side (see the header note on why the CLI's native /goal is unreachable).
   * From then on EVERY send is a goal run: the trigger is sent with the completion-
   * marker protocol and fabric iterates until the marker appears (or the caps).
   */
  async function setGoal(condition) {
    const c = String(condition ?? '').trim();
    if (!c) throw new Error('setGoal: a condition is required');
    goalCondition = c;
    goalActive = true;
    return { condition: c, active: true };
  }

  /**
   * Run the goal loop to completion (marker protocol). Each attempt sends the prompt
   * plus an instruction to work autonomously toward the condition and end the final
   * reply with exactly `<<GOAL_COMPLETE>>`. Marker present → met. Otherwise a
   * continuation is sent, up to maxTurns; timeoutMs caps the wall clock. 'timeout'
   * leaves the loop in place (the caller may re-run or close); state is reported
   * honestly either way.
   */
  function goalRun(text, opts = {}) {
    const maxTurns = opts.maxTurns ?? DEFAULT_GOAL_MAX_TURNS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GOAL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (!goalActive || !goalCondition) return reject(new Error('goalRun: no goal set — call setGoal(condition) first'));
      if (goalRunning) return reject(new Error('goalRun: a goal run is already in flight'));
      if (closed) return reject(new Error('openSession: session is closed'));
      goalRunning = true;
      const results = [];
      let hard = null;
      const finish = (state) => {
        clearTimeout(hard); goalRunning = false;
        const last = [...results].reverse().find((t) => t.trim()) ?? '';
        resolve({ text: last, turn: turnCount, turns: results.length, state });
      };
      hard = setTimeout(() => finish('timeout'), timeoutMs);
      hard.unref?.();
      const instruct = (body) =>
        `${body}\n\nWork autonomously toward the goal: ${goalCondition}. Do not pause to ask for confirmation. When the goal is complete, end your final reply with exactly the marker ${GOAL_MARKER}.`;
      const attempt = (i) => {
        if (closed) { clearTimeout(hard); goalRunning = false; return reject(new Error('openSession: session is closed')); }
        sendRaw(i === 0 ? instruct(text) : `Continue working toward the goal: ${goalCondition}. End your final reply with exactly the marker ${GOAL_MARKER}.`, 'goal').then(
          (r) => {
            results.push(r.text);
            if (r.text.includes(GOAL_MARKER)) return finish('met');
            if (results.length >= maxTurns) return finish('capped');
            attempt(results.length);
          },
          (e) => { clearTimeout(hard); goalRunning = false; reject(e); },
        );
      };
      attempt(0);
    });
  }

  function send(text, _label = 'user', opts) {
    // With a goal active every user message IS a goal run — the loop outcome is the
    // result. Mid-run interjections are refused: the loop owns the conversation.
    if (goalRunning) return Promise.reject(new Error('openSession: a goal run is in flight; wait for it or close the session'));
    if (goalActive) return goalRun(text, opts);
    return sendRaw(text, _label, opts);
  }

  // Native headless compaction: `/compact` sent as a user message IS the CLI's manual
  // compact — the CLI expands the slash command from a stream-json user message and
  // emits `compact_boundary` (trigger: "manual") before the result event (probed live
  // 2026-08-10: 30.8k → 1.2k tokens). A result WITHOUT a boundary means the compact
  // was refused (fresh session, blocking hook) — reported honestly as confirmed:false.
  // Compaction always uses the raw send — never a goal run, even with a goal active.
  async function compact({ timeoutMs = 120_000 } = {}) {
    const before = compactBoundaryAt;
    const r = await sendRaw('/compact', 'user', { timeoutMs });
    return { compacted: true, confirmed: compactBoundaryAt > before, text: r.text };
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
    // Reclaim the tmp runDir (config dir, observe http.jsonl, transcript). Best-effort and
    // last: a directory we cannot remove must not turn a successful close into a failure.
    if (reclaimRunDir) {
      try { rmSync(runDir, { recursive: true, force: true }); } catch { /* in use; the GC sweep gets it */ }
    }
    return exitCode;
  }

  /**
   * Content view: the tail of the always-recorded transcript + liveness facts. Read by
   * session_view / node/view so a session is inspectable from anywhere in the fleet.
   * content is "" until the first turn completes (no transcript rows yet), never an error.
   */
  function view({ tailChars = 8000 } = {}) {
    let content = "";
    try {
      content = readFileSync(transcriptPath, "utf8").slice(-tailChars);
    } catch { /* transcript not written yet */ }
    return {
      content,
      pid: child.pid ?? null,
      alive: !closed,
      turns: turnCount,
      lastActivity,
      sessionId,
      stderrTail: errTail(),
    };
  }

  return {
    runDir, jsonlPath: proxy?.jsonlPath ?? null,
    get turns() { return turnCount; },
    // The CLI's own session id (init event) — journaled for crash-recovery resume.
    get sessionId() { return sessionId; },
    // Liveness facts (G3): reported, never inferred — the layer above decides what to do.
    pid: child.pid ?? null,
    get alive() { return !closed; },
    get lastActivity() { return lastActivity; },
    stderrTail: errTail, // already secret-scrubbed at the source
    view,
    // Native compaction: the CLI compacts on a `/compact` user message (compact_boundary).
    get compactable() { return true; },
    // Native goal mode: /goal sets the condition; the CLI then auto-runs the loop.
    get goalActive() { return goalActive; },
    // Liveness fact for the console: a turn (streaming a reply) or a goal loop is in
    // flight RIGHT NOW. `pending` is the in-flight send slot; `goalRunning` covers the
    // fabric-side goal loop's owns-the-conversation window. This is the honest
    // "is it still outputting / still working" signal.
    get working() { return pending !== null || goalRunning; },
    get usage() {
      return {
        ...usage,
        // Cumulative API consumption (cost side): every token billed, including the
        // repeated cache reads. context_tokens is the WINDOW-FILL estimate (fresh input
        // + cached content), deliberately excluding cache_read — see the result handler.
        total_input_tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
        context_tokens: contextTokens,
      };
    },
    // Native compaction count (compact_boundary events observed) — the "↻N" the console
    // shows so a session's context pressure is read alongside how many times it was cut.
    get compacted() { return compactBoundaryAt; },
    send, setGoal, goalRun, compact, close,
  };
}
