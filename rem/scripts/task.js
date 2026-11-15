#!/usr/bin/env node
// task.js — the tasks layer CLI.
//
// The user's (/rem:task; refused by default without its authority record, see authority.mjs):
//   task.js open <slug> "<goal>" [--scope <paths>] [--owner <who>]
//   task.js close <slug> ["<reason>"] [--journal-only D<n>,...]
//     refuses while an item is open or a decision is undistilled, then archives the task
//     (git mv) to .claude/memory/<close-date>/task-<slug>/
// An agent's (user ruling 2026-11-15: an agent opens a task only under the user's authorization):
//   task.js request <slug> "<goal>"   records a request with a code; the user's own prompt
//     `approve <code>` (or `批准 <code>`) grants it, and then the agent may run task.js open
// Before close, distill (any session): cite tasks/<slug>/JOURNAL.md#D<n> from a memory entry
// (remember.js --from), a rule, or a bound doc. `task.js distill-status [<slug>]` lists what is left.
// Any session, on its BOUND task (--task <slug>, else the worktree/branch name):
//   task.js log "<progress>"            task.js decide "<decision>"   → D<n>
//   task.js open-item "<text>"          task.js close-item O<n> "<how>"
//   task.js handoff "<text>"
//   task.js translate --line <n> "<english line>"   the one sanctioned rewrite: line n must hold
//     foreign script; the replacement holds none and keeps `- <date> <tag>: ` byte-identical;
//     it then appends `- <date> progress: line <n> translated to English`
//   task.js amend --line <n> "<line>" --reason "<why>" --approved "<user's words>"   the EXCEPTION:
//     a line that is WRONG as written, corrected with the user's approval; the prefix stays
//     byte-identical and `- <date> progress: line <n> amended: <why> -- approved: "..." (was sha256:..)`
//     is appended. A changed mind is a new decision, never an amendment.
// Read-only:
//   task.js list                        task.js show [<slug>]         task.js bound
//   task.js distill-status [<slug>]     (show finds an archived task too)

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMain } from '../shared/lib.mjs';
import {
  openTask, appendJournal, translateJournalLine, amendJournalLine, closeTask, distillStatus, readTask, listTasks, resolveTask, findArchivedTask,
} from './tasks.mjs';
import { requestAuthority } from './authority.mjs';

const PREFIX = '[task]';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? null;
}

function bound(args) {
  const slug = resolveTask(cwd, { task: flag(args, '--task') });
  if (!slug) throw new Error('no open task is bound: pass --task <slug>, or work in a worktree/branch named after the task');
  return slug;
}

const JOURNAL_VERBS = { log: 'progress', decide: 'decision', 'open-item': 'open-item', handoff: 'handoff' };

export function main(argv) {
  const args = [...argv];
  const verb = args.shift();
  if (verb === 'request') {
    const [slug, ...goal] = args;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '')) throw new Error(`request needs a kebab-case slug, got ${slug}`);
    const asked = requestAuthority(cwd, 'open', slug, goal.join(' '));
    console.log(`${PREFIX} requested open ${slug}: ask the user to reply \`approve ${asked.code}\` (or \`批准 ${asked.code}\`); `
      + `then run task.js open ${slug} "<goal>"`);
  } else if (verb === 'open') {
    const scope = (flag(args, '--scope') || '').split(',').map(s => s.trim()).filter(Boolean);
    const owner = flag(args, '--owner') || 'user';
    const [slug, ...goal] = args;
    openTask(cwd, slug, goal.join(' '), { scope, owner });
    console.log(`${PREFIX} opened ${slug} → .claude/tasks/${slug}/`);
  } else if (verb === 'close') {
    const journalOnly = (flag(args, '--journal-only') || '').split(',').map(s => s.trim()).filter(Boolean);
    const [slug, ...reason] = args;
    const dest = closeTask(cwd, slug, reason.join(' '), { journalOnly });
    console.log(`${PREFIX} closed ${slug}; archived to ${dest}`);
  } else if (JOURNAL_VERBS[verb]) {
    const slug = bound(args);
    console.log(appendJournal(cwd, slug, JOURNAL_VERBS[verb], args.join(' ')));
  } else if (verb === 'close-item') {
    const slug = bound(args);
    const [item, ...how] = args;
    console.log(appendJournal(cwd, slug, `close-item:${item}`, how.join(' ') || 'done'));
  } else if (verb === 'translate') {
    const slug = bound(args);
    const n = flag(args, '--line');
    if (!n || args.length !== 1) throw new Error('usage: task.js translate [--task <slug>] --line <n> "<english line>"');
    console.log(translateJournalLine(cwd, slug, n, args[0]));
  } else if (verb === 'amend') {
    const slug = bound(args);
    const n = flag(args, '--line');
    const reason = flag(args, '--reason');
    const approved = flag(args, '--approved');
    if (!n || args.length !== 1) {
      throw new Error('usage: task.js amend [--task <slug>] --line <n> "<line>" --reason "<why>" --approved "<user\'s words>"');
    }
    console.log(amendJournalLine(cwd, slug, n, args[0], { reason, approved }));
  } else if (verb === 'list') {
    for (const t of listTasks(cwd)) console.log(`${t.slug}\t${t.status}\t${t.goal}`);
  } else if (verb === 'bound') {
    console.log(resolveTask(cwd, { task: flag(args, '--task') }) || '(none)');
  } else if (verb === 'show') {
    const slug = args[0] || bound(args);
    const dir = readTask(cwd, slug)?.dir || findArchivedTask(cwd, slug);
    if (!dir) throw new Error(`no task ${slug}`);
    process.stdout.write(readFileSync(join(dir, 'TASK.md'), 'utf8'));
    process.stdout.write('\n' + readFileSync(join(dir, 'JOURNAL.md'), 'utf8'));
  } else if (verb === 'distill-status') {
    const slug = args[0] || bound(args);
    const { undistilled, openItems } = distillStatus(cwd, slug);
    console.log(`undistilled: ${undistilled.map(n => `D${n}`).join(', ') || '(none)'}`);
    console.log(`open items: ${openItems.map(n => `O${n}`).join(', ') || '(none)'}`);
  } else {
    throw new Error('usage: task.js open|close|log|decide|open-item|close-item|handoff|translate|amend|list|show|bound|distill-status (see the header)');
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`${PREFIX} ${e.message}`); process.exitCode = 1; }
}
