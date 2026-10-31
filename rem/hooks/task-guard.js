#!/usr/bin/env node
// task-guard.js — PreToolUse hook: the SECOND line behind "opening/closing a task is refused
// by default and detectable when bypassed". The first line is the cause: openTask/closeTask
// refuse without the user's authority record (scripts/authority.mjs); scope-validate detects
// a bypass. This hook judges what a shell command DOES, never what it merely mentions:
//   - `task.js` whose VERB (first non-flag argument) is exactly `open` or `close`;
//   - an interpreter (node/python/…) whose inline code names the task library, the authority
//     store, or a path under .claude/tasks/;
//   - a known writer whose TARGET path lies under .claude/tasks/ or ~/.claude/rem/authority/:
//     redirections (> >>), tee, cp/mv/install/ln (destination), touch/mkdir/rm/truncate,
//     sed -i FILE, and PowerShell Set-Content/Add-Content/Out-File/New-Item/Copy-Item/… .
// Message and body arguments (git commit -m, --body …) and read-only commands never match.
// File tools are refused when they write a TASK.md / JOURNAL.md or the authority store.

import { readStdinJSON, isMain } from '../shared/lib.mjs';

const TASK_FILE_RE = /(?:^|[\\/])\.claude[\\/]tasks[\\/][^\\/]+[\\/](TASK|JOURNAL)\.md$/;
const STORE_RE = /(?:^|[\\/])\.claude[\\/]rem[\\/]authority(?:[\\/]|$)/;
const PROTECTED_RE = /(?:^|[\\/])\.claude[\\/]tasks(?:[\\/]|$)/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const INTERPRETERS = /^(?:python\d?(?:\.\d+)?|py|node|deno|bun|perl|ruby|php|pwsh|powershell)(?:\.exe)?$/i;
const CODE_RE = /\btasks\.mjs\b|\bauthority\.mjs\b|\b(?:openTask|closeTask|consumeAuthority|recordUserCommand)\b|\.claude[\\/]+(?:tasks|rem[\\/]+authority)\b/;
const TASK_FLAGS_WITH_VALUE = new Set(['--task', '--scope', '--owner', '--journal-only']);
const SINGLE_TARGET_WRITERS = new Set(['cp', 'mv', 'install', 'ln']);
// (one string, so the lifecycle scan for file removers sees names to recognise, not a call)
const ALL_TARGET_WRITERS = new Set('tee touch mkdir rm rmdir truncate unlink'.split(' '));
const PS_WRITERS = /^(?:set-content|add-content|out-file|new-item|copy-item|move-item|remove-item)$/i;

const REASON = 'Opening or closing a task is the user\'s /rem:task open|close command, and a task journal is '
  + 'append-only through `task.js log|decide|open-item|close-item|handoff`. Propose the change to the user instead.';

// Shell-ish split into segments at ; && || | and newlines. Quoted text stays inside its word
// as data; redirection operators become { redirect } items.
export function segments(command) {
  const out = [[]];
  let word = null;
  const push = () => { if (word !== null) out[out.length - 1].push(word); word = null; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '"' || c === "'") {
      const end = command.indexOf(c, i + 1);
      const j = end < 0 ? command.length : end;
      word = (word ?? '') + command.slice(i + 1, j);
      i = j;
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      push();
      if (command[i + 1] === c) i++;
      out.push([]);
    } else if (c === '>' || c === '<') {
      // A leading fd number (2>) belongs to the operator, not to a word.
      if (word !== null && /^\d$/.test(word)) word = null; else push();
      let op = c;
      while (command[i + 1] === '>' || command[i + 1] === '&') op += command[++i];
      if (op.endsWith('&')) { while (/\d/.test(command[i + 1] || '')) i++; }
      out[out.length - 1].push({ redirect: op });
    } else if (/\s/.test(c)) push();
    else word = (word ?? '') + c;
  }
  push();
  return out.filter(s => s.length);
}

const isFlag = w => /^-/.test(w);
const base = w => String(w).replace(/\\/g, '/').split('/').pop();
const protectedPath = (p, cwd) => {
  const full = cwd && !/^([\\/]|~|[A-Za-z]:)/.test(p) ? `${cwd}/${p}` : p;
  return PROTECTED_RE.test(full) || STORE_RE.test(full);
};

// The paths a segment WRITES, judged by its program and its redirections.
export function writeTargets(seg) {
  const targets = [];
  const words = [];
  for (let i = 0; i < seg.length; i++) {
    const w = seg[i];
    if (typeof w !== 'object') { words.push(w); continue; }
    if (w.redirect.endsWith('&')) continue; // 2>&1: duplicates a descriptor, names no file
    const next = seg[i + 1];
    if (typeof next === 'string') {
      if (w.redirect.startsWith('>')) targets.push(next);
      i++;
    }
  }
  const [prog = '', ...args] = words;
  const name = base(prog).toLowerCase();
  const positional = args.filter(a => !isFlag(a));
  if (ALL_TARGET_WRITERS.has(name)) targets.push(...positional);
  else if (SINGLE_TARGET_WRITERS.has(name) && positional.length) targets.push(positional[positional.length - 1]);
  else if (name === 'sed' && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    // Files are the positionals after the script: the script is the first positional,
    // unless scripts were given with -e/-f (then every positional is a file).
    const scripted = args.some(a => a === '-e' || a === '-f' || a === '--expression');
    const files = [];
    for (let k = 0; k < args.length; k++) {
      if (args[k] === '-e' || args[k] === '-f' || args[k] === '--expression') { k++; continue; }
      if (!isFlag(args[k])) files.push(args[k]);
    }
    targets.push(...(scripted ? files : files.slice(1)));
  } else if (PS_WRITERS.test(name)) {
    const k = args.findIndex(a => /^-(?:path|literalpath|filepath|destination)$/i.test(a));
    if (k >= 0 && args[k + 1]) targets.push(args[k + 1]);
    else if (positional.length) targets.push(/^(?:copy-item|move-item)$/i.test(name) ? positional[1] ?? positional[0] : positional[0]);
  }
  return targets;
}

// The first non-flag argument after task.js (flags that take a value skip it), or null.
function taskVerb(words) {
  const at = words.findIndex(w => /(?:^|[\\/])task\.js$/.test(w));
  if (at < 0) return null;
  for (let i = at + 1; i < words.length; i++) {
    if (TASK_FLAGS_WITH_VALUE.has(words[i])) { i++; continue; }
    if (!isFlag(words[i])) return words[i];
  }
  return '';
}

export function decideTaskGuard(payload) {
  const tool = payload?.tool_name || '';
  const input = payload?.tool_input || {};
  if (FILE_TOOLS.has(tool)) {
    const file = String(input.file_path || input.notebook_path || '');
    return { deny: TASK_FILE_RE.test(file) || STORE_RE.test(file) };
  }
  if (!SHELL_TOOLS.has(tool)) return { deny: false };
  let cwd = '';
  for (const seg of segments(String(input.command || ''))) {
    const words = seg.filter(w => typeof w === 'string');
    if (words[0] === 'cd') { cwd = words[1] || ''; continue; }
    const verb = taskVerb(words);
    if (verb === 'open' || verb === 'close') return { deny: true };
    if (verb === null && INTERPRETERS.test(base(words[0] || '')) && CODE_RE.test(words.slice(1).join(' '))) return { deny: true };
    if (writeTargets(seg).some(t => protectedPath(t, cwd))) return { deny: true };
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
