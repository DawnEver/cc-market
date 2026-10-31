#!/usr/bin/env node
// task.js — the tasks layer CLI.
//
// User-only (the /rem:task command; hooks/task-guard.js refuses an agent running them):
//   task.js open <slug> "<goal>" [--scope <paths>] [--owner <who>]
//   task.js close <slug> ["<reason>"] [--journal-only D<n>,...]
//     refuses while an item is open or a decision is undistilled, then archives the task
//     (git mv) to .claude/memory/<close-date>/task-<slug>/
// Before close, distill (any session): cite tasks/<slug>/JOURNAL.md#D<n> from a memory entry
// (remember.js --from), a rule, or a bound doc. `task.js distill-status [<slug>]` lists what is left.
// Any session, on its BOUND task (--task <slug>, else the worktree/branch name):
//   task.js log "<progress>"            task.js decide "<decision>"   → D<n>
//   task.js open-item "<text>"          task.js close-item O<n> "<how>"
//   task.js handoff "<text>"
// Read-only:
//   task.js list                        task.js show [<slug>]         task.js bound
//   task.js distill-status [<slug>]     (show finds an archived task too)

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMain } from '../shared/lib.mjs';
import {
  openTask, appendJournal, closeTask, distillStatus, readTask, listTasks, resolveTask, findArchivedTask,
} from './tasks.mjs';

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
  if (verb === 'open') {
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
    throw new Error('usage: task.js open|close|log|decide|open-item|close-item|handoff|list|show|bound|distill-status (see the header)');
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`${PREFIX} ${e.message}`); process.exitCode = 1; }
}
