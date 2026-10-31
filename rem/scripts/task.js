#!/usr/bin/env node
// task.js — the tasks layer CLI.
//
// User-only (the /rem:task command; hooks/task-guard.js refuses an agent running them):
//   task.js open <slug> "<goal>" [--scope <paths>] [--owner <who>]
//   task.js close <slug> ["<reason>"]
// Any session, on its BOUND task (--task <slug>, else the worktree/branch name):
//   task.js log "<progress>"            task.js decide "<decision>"   → D<n>
//   task.js open-item "<text>"          task.js close-item O<n> "<how>"
//   task.js handoff "<text>"
// Read-only:
//   task.js list                        task.js show [<slug>]         task.js bound

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMain } from '../shared/lib.mjs';
import {
  openTask, appendJournal, setTaskStatus, readTask, listTasks, resolveTask,
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
    const [slug, ...reason] = args;
    const task = readTask(cwd, slug);
    if (!task || task.status !== 'open') throw new Error(`no open task ${slug}`);
    appendJournal(cwd, slug, 'closed', reason.join(' ') || 'closed by the user');
    setTaskStatus(cwd, slug, 'closed');
    console.log(`${PREFIX} closed ${slug}`);
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
    const task = readTask(cwd, slug);
    if (!task) throw new Error(`no task ${slug}`);
    process.stdout.write(readFileSync(join(task.dir, 'TASK.md'), 'utf8'));
    process.stdout.write('\n' + readFileSync(join(task.dir, 'JOURNAL.md'), 'utf8'));
  } else {
    throw new Error('usage: task.js open|close|log|decide|open-item|close-item|handoff|list|show|bound (see the header)');
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`${PREFIX} ${e.message}`); process.exitCode = 1; }
}
