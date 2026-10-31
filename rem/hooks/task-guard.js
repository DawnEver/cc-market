#!/usr/bin/env node
// task-guard.js — PreToolUse hook: the SECOND line behind "opening/closing a task is refused
// by default and detectable when bypassed". The first line is the cause: openTask/closeTask refuse without a record that only
// the user's own /rem:task prompt creates (scripts/authority.mjs). This hook refuses the
// visible attempts early and with a clear reason: an agent writing a TASK.md, rewriting a
// JOURNAL.md, running task.js open|close in any argument order, importing the task library
// or the authority store, or pointing an interpreter or a shell write at .claude/tasks/.
// Reading tasks and `task.js log|decide|open-item|close-item|handoff` stay allowed.

import { readStdinJSON, isMain } from '../shared/lib.mjs';

const TASK_FILE_RE = /(?:^|[\\/])\.claude[\\/]tasks[\\/][^\\/]+[\\/](TASK|JOURNAL)\.md$/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const LIBRARY_RE = /\btasks\.mjs\b|\bauthority\.mjs\b|\b(?:openTask|closeTask|consumeAuthority|recordUserCommand)\b|rem[\\/]+authority\b/;
const VERB_RE = /(?:^|\s)(?:open|close)(?=\s|$)/;
const TASK_PATH_RE = /\.claude[\\/]+tasks\b|\b(?:TASK|JOURNAL)\.md\b/;
const WRITER_RE = />|\btee\b|\b(?:cp|mv|rm|touch|mkdir|sed\s+-i|truncate|dd|install|ln)\b|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|writeFile|appendFile|makedirs|open\(/i;
const INTERPRETER_RE = /\b(?:python\d?(?:\.\d+)?|py|node|deno|bun|perl|ruby|php|pwsh|powershell|bash|sh|zsh|cmd)\b/i;

const REASON = 'Opening or closing a task is the user\'s /rem:task open|close command, and a task journal is '
  + 'append-only through `task.js log|decide|open-item|close-item|handoff`. Propose the change to the user instead.';

// Quoted text is data (a journal line may say "open" or "close"); verbs are bare words.
const unquoted = cmd => cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ');

export function decideTaskGuard(payload) {
  const tool = payload?.tool_name || '';
  const input = payload?.tool_input || {};
  if (FILE_TOOLS.has(tool)) {
    const file = String(input.file_path || input.notebook_path || '');
    return { deny: TASK_FILE_RE.test(file) || /(?:^|[\\/])\.claude[\\/]rem[\\/]authority[\\/]/.test(file) };
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command || '');
    if (LIBRARY_RE.test(cmd)) return { deny: true };
    if (/\btask\.js\b/.test(cmd) && VERB_RE.test(unquoted(cmd))) return { deny: true };
    return { deny: TASK_PATH_RE.test(cmd) && (WRITER_RE.test(cmd) || INTERPRETER_RE.test(cmd)) };
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
