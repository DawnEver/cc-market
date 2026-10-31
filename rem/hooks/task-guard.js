#!/usr/bin/env node
// task-guard.js — PreToolUse hook: only the user opens (and closes) a task.
//
// The user's /rem:task command runs task.js through command expansion, which is not a
// tool call, so it never reaches this hook. Every agent tool call does, and is refused when
// it would write a task's TASK.md, rewrite its JOURNAL.md (appends go through task.js), or
// run task.js open/close. Reading tasks and `task.js log|decide|...` stay allowed.

import { readStdinJSON, isMain } from '../shared/lib.mjs';

const TASK_FILE_RE = /(?:^|[\\/])\.claude[\\/]tasks[\\/][^\\/]+[\\/](TASK|JOURNAL)\.md$/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const OPEN_CLOSE_RE = /task\.js["']?\s+(?:open|close)\b/;
const TASK_PATH_RE = /\.claude[\\/]tasks[\\/][^\s"'`]*(?:TASK|JOURNAL)\.md/;
const SHELL_WRITE_RE = />|\btee\b|\b(?:cp|mv|rm|touch|sed\s+-i|truncate|dd)\b|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|writeFile|appendFile/i;

const REASON = 'Only the user opens or closes a task (/rem:task open|close), and a task journal is '
  + 'append-only through `task.js log|decide|open-item|close-item|handoff`. Propose the change to the user instead.';

export function decideTaskGuard(payload) {
  const tool = payload?.tool_name || '';
  const input = payload?.tool_input || {};
  if (FILE_TOOLS.has(tool)) {
    const file = String(input.file_path || input.notebook_path || '');
    return { deny: TASK_FILE_RE.test(file) };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command || '');
    if (OPEN_CLOSE_RE.test(cmd)) return { deny: true };
    return { deny: TASK_PATH_RE.test(cmd) && SHELL_WRITE_RE.test(cmd) };
  }
  return { deny: false };
}

if (isMain(import.meta.url)) {
  let payload = {};
  try { payload = readStdinJSON() || {}; } catch { /* no payload: allow */ }
  if (decideTaskGuard(payload).deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
    }));
  }
}
