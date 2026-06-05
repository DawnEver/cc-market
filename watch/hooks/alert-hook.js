#!/usr/bin/env node
// alert-hook.js — watch plugin Claude Code hook.
// Emails on Notification events (usage/quota/error) and Stop events (fail streaks).
// Registered in hooks/hooks.json for Notification and Stop events.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateFile = path.join(projectDir, '.claude', '.watch-alert-state.json');

const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 3;
const TRANSCRIPT_TAIL = 60;

const LIMIT_RE =
  /(usage|quota|credit|billing|rate.?limit|limit reached|overloaded|insufficient|exceeded)/i;
const FAIL_TEXT_RE =
  /(unable to|couldn'?t|can'?t\b|still fail|not working|stuck|giving up|didn'?t work|no luck)/i;

function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function loadJSON(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveJSON(file, data) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* never fail the session over state persistence */
  }
}

function readTranscriptTail(transcriptPath, maxLines = TRANSCRIPT_TAIL) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-maxLines)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadWatchConfig() {
  const configPath = path.join(projectDir, '.claude', 'watch.yaml');
  // Fallback for legacy name
  const legacyPath = path.join(projectDir, '.claude', 'ops-supervisor.yaml');
  for (const p of [configPath, legacyPath]) {
    if (fs.existsSync(p)) {
      try {
        // Minimal YAML parse — read the to/from fields
        const text = fs.readFileSync(p, 'utf8');
        const toMatch = text.match(/^\s*to:\s*"([^"]+)"/m) || text.match(/^\s*to:\s*'([^']+)'/m) || text.match(/^\s*to:\s*(\S+)/m);
        const prefixMatch = text.match(/^\s*subject_prefix:\s*"([^"]+)"/m) || text.match(/^\s*subject_prefix:\s*'([^']+)'/m);
        return {
          to: toMatch ? toMatch[1] : '',
          subjectPrefix: prefixMatch ? prefixMatch[1] : '[watch]',
        };
      } catch (e) {
        return {};
      }
    }
  }
  return {};
}

function sendAlert(subject, html) {
  const wc = loadWatchConfig();
  const recipient = process.env.WATCH_ALERTS_EMAIL_TO || wc.to || process.env.EMAIL_TO || 'admin@localhost';
  const prefix = wc.subjectPrefix || '[watch]';

  if (process.env.CLAUDE_ALERT_DRYRUN === '1' || process.env.WATCH_DRYRUN === '1') {
    process.stderr.write(
      `[watch-alert DRYRUN] to=${recipient}\nsubject=${prefix} ${subject}\n${html.slice(0, 500)}\n`
    );
    return;
  }

  try {
    const sendScript = path.join(pluginRoot, 'scripts', 'send_alert.py');
    // Try python3 first, fall back to python
    let pythonCmd = 'python3';
    let proc = spawnSync(pythonCmd, [sendScript,
      '--project-dir', projectDir,
      '--subject', `${prefix} ${subject}`,
      '--body', html,
    ], { cwd: projectDir, timeout: 15000 });
    if (proc.error && proc.error.code === 'ENOENT') {
      pythonCmd = 'python';
      proc = spawnSync(pythonCmd, [sendScript,
        '--project-dir', projectDir,
        '--subject', `${prefix} ${subject}`,
        '--body', html,
      ], { cwd: projectDir, timeout: 15000 });
    }
    if (proc.status !== 0) {
      process.stderr.write(`[watch-alert] send_alert.py failed (${pythonCmd}): ${proc.stderr}\n`);
    }
  } catch (err) {
    process.stderr.write(`[watch-alert] send failed: ${err}\n`);
  }
}

// --- Turn analysis ---------------------------------------------------------

function isRealUserPrompt(entry) {
  if (entry?.message?.role !== 'user') return false;
  const c = entry.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return c.some((b) => b?.type !== 'tool_result');
  return false;
}

function latestTurn(transcript) {
  let start = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (isRealUserPrompt(transcript[i])) { start = i + 1; break; }
  }
  return transcript.slice(start);
}

function lastAssistantText(turn) {
  const texts = turn
    .filter((e) => e?.message?.role === 'assistant')
    .flatMap((e) => {
      const c = e?.message?.content;
      return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text) : [];
    });
  return texts.length ? texts[texts.length - 1] : '';
}

function turnFailed(turn) {
  const finalText = lastAssistantText(turn);
  if (finalText) return FAIL_TEXT_RE.test(finalText);
  for (let i = turn.length - 1; i >= 0; i--) {
    const c = turn[i]?.message?.content;
    if (!Array.isArray(c)) continue;
    if (c.some((b) => b?.type === 'tool_result' && b?.is_error === true)) return true;
    if (c.some((b) => b?.type === 'text' || b?.type === 'tool_use')) return false;
  }
  return false;
}

// --- Handlers ---------------------------------------------------------------

function handleNotification(input, state) {
  const message = input.message || '';
  if (!LIMIT_RE.test(message)) return state;

  const now = Date.now();
  const key = (message.match(LIMIT_RE) || [''])[0].toLowerCase();
  if (
    state.lastNotificationKey === key &&
    state.lastNotificationAt &&
    now - state.lastNotificationAt < NOTIFY_COOLDOWN_MS
  ) {
    return state;
  }

  sendAlert(
    'Claude Code error/limit notification',
    `<h2>Claude Code surfaced an error/limit notification</h2>` +
      `<p><b>Message:</b> ${escapeHtml(message)}</p>` +
      `<p><b>Project:</b> ${escapeHtml(input.cwd || projectDir)}</p>` +
      `<p><b>Session:</b> ${escapeHtml(input.session_id || '')}</p>`
  );
  return { ...state, lastNotificationAt: now, lastNotificationKey: key };
}

function handleStop(input, state) {
  const transcript = input.transcript_path ? readTranscriptTail(input.transcript_path) : [];
  if (!transcript.length) return state;

  const turn = latestTurn(transcript);
  if (turnFailed(turn)) {
    const failStreak = (state.failStreak || 0) + 1;
    let lastEmailedStreak = state.lastEmailedStreak || 0;
    if (
      failStreak >= FAIL_THRESHOLD &&
      failStreak % FAIL_THRESHOLD === 0 &&
      failStreak !== lastEmailedStreak
    ) {
      sendAlert(
        `Claude failed ${failStreak} rounds in a row`,
        `<h2>Claude has failed ${failStreak} turns in a row</h2>` +
          `<p><b>Project:</b> ${escapeHtml(input.cwd || projectDir)}</p>` +
          `<p><b>Session:</b> ${escapeHtml(input.session_id || '')}</p>` +
          `<p><b>Last assistant message:</b></p>` +
          `<pre>${escapeHtml(lastAssistantText(turn).slice(0, 1500))}</pre>`
      );
      lastEmailedStreak = failStreak;
    }
    return { ...state, failStreak, lastEmailedStreak };
  }
  return { ...state, failStreak: 0, lastEmailedStreak: 0 };
}

// --- Main -------------------------------------------------------------------

function main() {
  if (process.env.CLAUDE_ALERT_ENABLED === 'false') return;
  const input = readStdinJSON();
  if (input.stop_hook_active) return;

  const sessionId = input.session_id || '';
  let state = loadJSON(stateFile);
  if (!state || state.sessionId !== sessionId) {
    state = {
      sessionId,
      failStreak: 0,
      lastEmailedStreak: 0,
      lastNotificationAt: 0,
      lastNotificationKey: '',
    };
  }

  const event = input.hook_event_name;
  if (event === 'Notification') {
    state = handleNotification(input, state);
  } else if (event === 'Stop') {
    state = handleStop(input, state);
  }

  saveJSON(stateFile, state);
}

try {
  main();
} catch (err) {
  try {
    process.stderr.write(`[watch-alert] hook error: ${err}\n`);
  } catch { /* ignore */ }
}
process.exit(0);
