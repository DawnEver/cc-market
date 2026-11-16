#!/usr/bin/env node
// task.js -- the tasks layer CLI. Its verbs, who may run each and what each does are ONE table,
// task-verbs.mjs (`task.js help`, `task.js verbs --json`); the mechanism is
// skills/rem/reference/tasks.md. A bound verb acts on --task <slug>, else on the task the user
// bound the session to with a `task: <slug>` prompt (rem's prompt hook, hooks/task-authority.js,
// writes it into the ledger). THE LEDGER IS REPO STATE (cc-market #20): every verb reads and
// writes <main checkout>/.claude/tasks/ (tasks.mjs tasksDir) from any worktree; nothing commits
// it on a branch. Retired verbs are refused naming why (RETIRED_VERBS).

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMain } from '../shared/lib.mjs';
import {
  openTask, placeTask, appendJournal, translateJournalLine, amendJournalLine, closeTask, distillStatus, readTask, listTasks, resolveTask, findArchivedTask, taskStatus, tasksDir, BIND_DOOR,
} from './tasks.mjs';
import { requestAuthority } from './authority.mjs';
import { VERBS, helpText } from './task-verbs.mjs';

const PREFIX = '[task]';
// Retired verbs, each refused naming why and what replaced it (every wall teaches).
export const RETIRED_VERBS = {
  'commit-record': 'retired 2026-11-16 (cc-market #20): the ledger is repo state in the main checkout, read from every '
    + 'worktree, and never committed on a feature branch -- nothing to copy or commit',
};
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
  if (!slug) throw new Error(`no open task is bound: pass --task <slug>, or ${BIND_DOOR}`);
  return slug;
}

const usage = verb => new Error(`usage: task.js ${verb} ${VERBS.find(v => v.verb === verb).args}`);

const JOURNAL_VERBS = { log: 'progress', decide: 'decision', 'open-item': 'open-item', handoff: 'handoff' };

export function main(argv) {
  const args = [...argv];
  const verb = args.shift();
  if (Object.hasOwn(RETIRED_VERBS, verb)) throw new Error(`task.js ${verb} is ${RETIRED_VERBS[verb]}`);
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
    console.log(`${PREFIX} opened ${slug} → ${join(tasksDir(cwd), slug)} (the ledger every worktree reads)`);
    console.log(`${PREFIX} to work on it, bind a session with a prompt whose first line is \`task: ${slug}\`; `
      + `its branches are pr/${slug}/<feature>, never a bare pr/${slug}`);
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
    if (!n || args.length !== 1) throw usage(verb);
    console.log(translateJournalLine(cwd, slug, n, args[0]));
  } else if (verb === 'amend') {
    const slug = bound(args);
    const n = flag(args, '--line');
    const reason = flag(args, '--reason');
    const approved = flag(args, '--approved');
    if (!n || args.length !== 1) throw usage(verb);
    console.log(amendJournalLine(cwd, slug, n, args[0], { reason, approved }));
  } else if (verb === 'place') {
    const [slug] = args;
    if (!slug) throw usage(verb);
    console.log(`${PREFIX} ${placeTask(cwd, slug)}`);
  } else if (verb === 'list') {
    for (const t of listTasks(cwd)) {
      console.log(`${t.slug}\t${t.status}\t${t.openItems.length} open\t${t.decisions.length} decisions\t${t.goal}`);
    }
  } else if (verb === 'status') {
    const distill = args.includes('--distill');
    const rest = args.filter(a => a !== '--distill');
    const named = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
    const slug = named || resolveTask(cwd, { task: flag(rest, '--task') });
    if (!slug) { console.log(`no task bound: ${BIND_DOOR}`); return; }
    const task = readTask(cwd, slug);
    if (!task) throw new Error(`no task ${slug}`);
    console.log(taskStatus(task, distill ? { undistilled: distillStatus(cwd, slug).undistilled } : {}));
  } else if (verb === 'show') {
    const slug = args[0] || bound(args);
    const dir = readTask(cwd, slug)?.dir || findArchivedTask(cwd, slug);
    if (!dir) throw new Error(`no task ${slug}`);
    process.stdout.write(readFileSync(join(dir, 'TASK.md'), 'utf8'));
    process.stdout.write('\n' + readFileSync(join(dir, 'JOURNAL.md'), 'utf8'));
  } else if (verb === 'help') {
    console.log(helpText());
  } else if (verb === 'verbs') {
    console.log(JSON.stringify(VERBS, null, 2));
  } else {
    throw new Error(`unknown verb ${verb ?? '(none)'}; every verb: task.js help`);
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`${PREFIX} ${e.message}`); process.exitCode = 1; }
}
