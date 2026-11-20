#!/usr/bin/env node
// task-guard.js — PreToolUse hook: the SECOND line behind "opening/closing a task is refused
// by default and detectable when bypassed". The first line is the cause: openTask/closeTask
// refuse without the user's authority record (scripts/authority.mjs); scope-validate detects
// a bypass. This hook judges what a shell command DOES, never what it merely mentions:
//   - `task.js` whose VERB (first non-flag argument) is exactly `open` or `close`;
//   - an interpreter (node/python/…) whose CODE — the -e/-c/--eval/-Command value or a heredoc
//     body — names the task library, the authority store, or a path under .claude/tasks/ (even to
//     read: use cat). A script's ARGUMENTS are data: citing a JOURNAL.md as evidence is reading;
//   - a shell's -c / -Command string (bash, sh, pwsh, powershell, cmd /c), re-judged as a
//     command line, recursively;
//   - a known writer whose TARGET path lies under .claude/tasks/ or ~/.claude/rem/authority/:
//     redirections (> >>), tee, cp/mv/install/ln (destination), touch/mkdir/rm/truncate,
//     sed -i FILE, and PowerShell Set-Content/Add-Content/Out-File/New-Item/Copy-Item/… .
// Consecutive cd's compose into one effective cwd for relative targets.
// Message and body arguments (git commit -m, --body …), a journal item's free text (whatever
// verb words it holds) and read-only commands never match.
// Every refusal names its cause and its door (the task.js verb, or the user's /rem:task command).
//
// Accepted misses, by design (a regex judge cannot close every path):
//   - a verb hidden by $'..', variables, eval or xargs — the library still refuses without
//     the user's authority grant (authority.mjs);
//   - paths built by concatenation, symlinks into .claude/tasks, scripts on disk, git apply —
//     detection is the backstop (scope-validate + git history of TASK.md).
// File tools are refused when they write a TASK.md / JOURNAL.md or the authority store.

import { readStdinJSON, isMain } from '../shared/lib.mjs';
import { isAgyHost, normalizeHookInput, hookOutput, emitHookOutput } from '../shared/hook-facts.mjs';
import { join } from 'path';
import { verbsOf } from '../scripts/task-verbs.mjs';
import { machineHome } from '../scripts/session-binding.mjs';

// A task's record. A session binding (written only by the user's `task: <slug>` prompt, through task-authority.js)
// lives in the machine home, `$LAB_COMMONS_HOME/state/sessions/` (D34, scripts/session-binding.mjs): the resolved
// directory is matched by prefix, and SESSIONS_RE catches a shell spelling of the variable (inSessionStore).
const TASK_FILE_RE = /(?:^|[\\/])\.claude[\\/]tasks[\\/][^\\/]+[\\/](TASK|JOURNAL)\.md$/;
const SESSIONS_RE = /(?:\$\{?|%|\$env:)LAB_COMMONS_HOME\}?%?[\\/]+state[\\/]+sessions(?:[\\/]|$)/i;
const fold = p => String(p).replace(/\\/g, '/').toLowerCase();
const sessionsDir = () => { try { return fold(join(machineHome(), 'state', 'sessions')); } catch { return null; } };
const inSessionStore = p => {
  const dir = sessionsDir();
  return SESSIONS_RE.test(p) || (dir !== null && `${fold(p)}/`.startsWith(`${dir}/`));
};
const STORE_RE = /(?:^|[\\/])\.claude[\\/]rem[\\/]authority(?:[\\/]|$)/;
const PROTECTED_RE = /(?:^|[\\/])\.claude[\\/]tasks(?:[\\/]|$)/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const INTERPRETERS = /^(?:python\d?(?:\.\d+)?|py|node|deno|bun|perl|ruby|php|pwsh|powershell)(?:\.exe)?$/i;
const CODE_RE = /\btasks\.mjs\b|\bsession-binding\.mjs\b|\bstate[\\/]+sessions\b|\bauthority\.mjs\b|\b(?:openTask|closeTask|consumeAuthority|recordUserCommand)\b|\.claude[\\/]+(?:tasks|rem[\\/]+authority)\b/;
const TASK_FLAGS_WITH_VALUE = new Set(['--task', '--line', '--scope', '--owner', '--journal-only']);
const SINGLE_TARGET_WRITERS = new Set(['cp', 'mv', 'install', 'ln']);
// (one string, so the lifecycle scan for file removers sees names to recognise, not a call)
const ALL_TARGET_WRITERS = new Set('tee touch mkdir rm rmdir truncate unlink'.split(' '));
const PS_WRITERS = /^(?:set-content|add-content|out-file|new-item|copy-item|move-item|remove-item)$/i;

const CODE_FLAG = /^(?:-e|-E|--eval|-p|--print|-c|-command)(?:=(.*))?$/i;
const DOOR = `Door: task.js ${verbsOf("append").join("|")} appends to the bound task's journal and ${verbsOf("rewrite").join("|")} rewrites one line `
  + "(every verb: task.js help); the ledger is repo state, never committed on a branch, and a session binding is written only by the user's `task: <slug>` prompt; "
  + "read a task with cat/grep or task.js status; opening or closing a task is the user's /rem:task "
  + "open|close command -- propose it to the user.";
const refuse = cause => `task-guard: ${cause}. ${DOOR}`;

// Heredocs: `<<[-] DELIM` … `DELIM`. The body is cut out of the command line and its place
// taken by a marker word, so the body is never parsed as commands; segments() turns the
// marker into a { heredoc } item — code for an interpreter, data for anything else.
const HEREDOC_RE = /<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/g;
const MARKER_RE = /^\u0000HEREDOC(\d+)\u0000$/;

function cutHeredocs(command) {
  const bodies = [];
  let text = command;
  for (;;) {
    HEREDOC_RE.lastIndex = 0;
    const m = HEREDOC_RE.exec(text);
    if (!m) break;
    const lineEnd = text.indexOf('\n', m.index);
    if (lineEnd < 0) { text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length); continue; }
    const lines = text.slice(lineEnd + 1).split('\n');
    const close = lines.findIndex(l => l.replace(/^\t+/, '') === m[2]);
    const body = (close < 0 ? lines : lines.slice(0, close)).join('\n');
    const rest = close < 0 ? '' : lines.slice(close + 1).join('\n');
    bodies.push(body);
    text = text.slice(0, m.index) + ` \u0000HEREDOC${bodies.length - 1}\u0000 ` + text.slice(m.index + m[0].length, lineEnd + 1) + rest;
  }
  return { text, bodies };
}

// Shell-ish split into segments at ; && || | and newlines. Quoted text stays inside its word
// as data; redirection operators become { redirect } items, heredocs { heredoc } items.
export function segments(command) {
  const { text, bodies } = cutHeredocs(command);
  command = text;
  const out = [[]];
  let word = null;
  const push = () => {
    if (word === null) return;
    const h = word.match(MARKER_RE);
    out[out.length - 1].push(h ? { heredoc: bodies[Number(h[1])] } : word);
    word = null;
  };
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
  return PROTECTED_RE.test(full) || STORE_RE.test(full) || inSessionStore(full);
};

// The paths a segment WRITES, judged by its program and its redirections.
export function writeTargets(seg) {
  const targets = [];
  const words = [];
  for (let i = 0; i < seg.length; i++) {
    const w = seg[i];
    if (typeof w !== 'object') { words.push(w); continue; }
    if (!w.redirect || w.redirect.endsWith('&')) continue; // 2>&1: duplicates a descriptor, names no file
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
    if (!TASK_FILE_RE.test(file) && !STORE_RE.test(file) && !inSessionStore(file)) return { deny: false };
    return { deny: true, reason: refuse(`${tool} writes ${file}, which only task.js or the user's /rem:task command may change`) };
  }
  if (!SHELL_TOOLS.has(tool)) return { deny: false };
  const cause = judgeCommandLine(String(input.command || ''), '', 0);
  return cause ? { deny: true, reason: refuse(cause) } : { deny: false };
}

const SHELLS = /^(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\.exe)?$/i;
const SHELL_COMMAND_FLAG = /^(?:-c|-command|\/c)$/i;
const MAX_DEPTH = 4;

// cd's compose: an absolute or home path replaces the cwd, a relative one extends it.
const composeCwd = (cwd, to) => (!to || /^([\\/]|~|[A-Za-z]:)/.test(to) || !cwd ? to || '' : `${cwd}/${to}`);

// The code an interpreter runs: its -e/-c/--eval/-Command values and heredoc bodies. A script
// path and the script's arguments are data the script reads, never code judged here.
function interpreterCode(words, seg) {
  const code = [];
  for (let i = 1; i < words.length; i++) {
    const m = words[i].match(CODE_FLAG);
    if (!m) continue;
    if (m[1] !== undefined) code.push(m[1]);
    else if (words[i + 1] !== undefined) code.push(words[++i]);
  }
  return [...code, ...seg.filter(w => w && w.heredoc !== undefined).map(w => w.heredoc)].join('\n');
}

// The refusal cause when a command line (or a shell's -c string in it, recursively) is refused, else null.
function judgeCommandLine(command, cwd, depth) {
  if (depth > MAX_DEPTH) return `shell -c nesting deeper than ${MAX_DEPTH} levels is not ordinary work`;
  for (const seg of segments(command)) {
    const words = seg.filter(w => typeof w === 'string');
    const prog = base(words[0] || '');
    if (prog === 'cd') { cwd = composeCwd(cwd, words[1]); continue; }
    const verb = taskVerb(words);
    if (verb === 'open' || verb === 'close') return `\`task.js ${verb}\` is the user's /rem:task ${verb} command, not an agent's`;
    if (SHELLS.test(prog)) {
      const k = words.findIndex((w, i) => i > 0 && SHELL_COMMAND_FLAG.test(w));
      const inner = k > 0 && words[k + 1] !== undefined && judgeCommandLine(words.slice(k + 1).join(' '), cwd, depth + 1);
      if (inner) return inner;
    }
    if (verb === null && INTERPRETERS.test(prog) && CODE_RE.test(interpreterCode(words, seg))) {
      return `${prog} runs code that names the task library, the authority store or a .claude/tasks path`;
    }
    const target = writeTargets(seg).find(t => protectedPath(t, cwd));
    if (target !== undefined) return `${prog || 'a redirection'} writes ${target}, inside .claude/tasks, the session binding store or the authority store`;
  }
  return null;
}

if (isMain(import.meta.url)) {
  let payload = {};
  try { payload = readStdinJSON() || {}; } catch { /* no payload: allow */ }
  const host = isAgyHost(payload) ? 'agy' : 'claude';
  payload = normalizeHookInput(payload);
  const decision = decideTaskGuard(payload);
  emitHookOutput(hookOutput({ host, event: 'PreToolUse', kind: decision.deny ? 'deny' : 'none', reason: decision.reason || '' }));
}
