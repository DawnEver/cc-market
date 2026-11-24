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
  openTask, setNeeds, placeTask, appendJournal, translateJournalLine, amendJournalLine, closeTask, distillStatus, distillJournal, distillByPlan, findDecision, journalText, readTask, listTasks, resolveTask, findArchivedTask, taskStatus, tasksDir, unboundReason, boundCheckout,
} from './tasks.mjs';
import { requestAuthority } from './authority.mjs';
import { VERBS, helpText } from './task-verbs.mjs';
import { keptEventsText } from './feed-events.mjs';

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

// The task a journal verb acts on and the checkout whose ledger holds it: --task in this repo, else the session's
// binding -- in this repo's ledger, or in the ledger of the repo the user bound it in (a task hosted elsewhere, D88).
function bound(args) {
  const task = flag(args, '--task');
  const at = task ? cwd : boundCheckout(cwd) || cwd;
  const slug = resolveTask(at, { task });
  if (!slug) throw new Error(`no open task is bound: pass --task <slug>, or ${unboundReason(at)}`);
  return [slug, at];
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
    console.log(`${PREFIX} requested open ${slug}: ask the user to reply \`approve ${asked.code}\` (or \`\u6279\u51c6 ${asked.code}\`); `
      + `then run task.js open ${slug} "<goal>"`);
  } else if (verb === 'open') {
    const scope = (flag(args, '--scope') || '').split(',').map(s => s.trim()).filter(Boolean);
    const needs = (flag(args, '--needs') || '').split(',').map(s => s.trim()).filter(Boolean);
    const owner = flag(args, '--owner') || 'user';
    const [slug, ...goal] = args;
    openTask(cwd, slug, goal.join(' '), { scope, needs, owner });
    console.log(`${PREFIX} opened ${slug} → ${join(tasksDir(cwd), slug)} (the ledger every worktree reads); its identity: ${readTask(cwd, slug).issue}`);
    console.log(`${PREFIX} to work on it, bind a session with a prompt whose first line is \`task: ${slug}\`; `
      + `its branches are pr/${slug}/<feature>, never a bare pr/${slug}`);
  } else if (verb === 'close') {
    const journalOnly = (flag(args, '--journal-only') || '').split(',').map(s => s.trim()).filter(Boolean);
    const [slug, ...reason] = args;
    const dest = closeTask(cwd, slug, reason.join(' '), { journalOnly });
    console.log(`${PREFIX} closed ${slug}; archived to ${dest}`);
  } else if (JOURNAL_VERBS[verb]) {
    const [slug, at] = bound(args);
    console.log(appendJournal(at, slug, JOURNAL_VERBS[verb], args.join(' ')));
  } else if (verb === 'close-item') {
    const [slug, at] = bound(args);
    const [item, ...how] = args;
    console.log(appendJournal(at, slug, `close-item:${item}`, how.join(' ') || 'done'));
  } else if (verb === 'translate') {
    const [slug, at] = bound(args);
    const n = flag(args, '--line');
    if (!n || args.length !== 1) throw usage(verb);
    console.log(translateJournalLine(at, slug, n, args[0]));
  } else if (verb === 'amend') {
    const [slug, at] = bound(args);
    const n = flag(args, '--line');
    const reason = flag(args, '--reason');
    const approved = flag(args, '--approved');
    if (!n || args.length !== 1) throw usage(verb);
    console.log(amendJournalLine(at, slug, n, args[0], { reason, approved }));
  } else if (verb === 'needs') {
    const [slug, at] = bound(args);
    const [sub, list = ''] = args;
    if (sub !== 'set' || args.length > 2) throw usage(verb);
    console.log(setNeeds(at, slug, list));
  } else if (verb === 'place') {
    const [slug] = args;
    if (!slug) throw usage(verb);
    console.log(`${PREFIX} ${placeTask(cwd, slug)}`);
  } else if (verb === 'list') {
    for (const t of listTasks(cwd)) {
      console.log(`${t.slug}\t${t.status}\t${t.openItems.length} open\t${t.decisions.length} decisions\t${t.goal}`);
    }
  } else if (verb === 'distill') {
    const [slug, at] = bound(args);
    const plan = flag(args, '--plan');
    if (plan) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(plan, 'utf8')); } catch (e) { throw new Error(`cannot read the plan ${plan}: ${e.message}`); }
      console.log(`${PREFIX} ${distillByPlan(at, slug, parsed)}`);
    } else {
      const keep = flag(args, '--keep');
      const days = flag(args, '--keep-days');
      const before = flag(args, '--before');
      console.log(`${PREFIX} ${distillJournal(at, slug, {
        ...(keep !== null ? { keep: Number(keep) } : {}), ...(days !== null ? { keepDays: Number(days) } : {}), ...(before ? { before } : {}),
      })}`);
    }
  } else if (verb === 'status') {
    const distill = args.includes('--distill');
    const rest = args.filter(a => a !== '--distill');
    const decisionsFlag = flag(rest, '--decisions');
    if (rest[0] && /^D\d+$/.test(rest[0])) {
      const slug = resolveTask(cwd, { task: flag(rest, '--task') });
      if (!slug) throw new Error(`no task bound to look ${rest[0]} up in: pass --task <slug>`);
      const hit = findDecision(cwd, slug, Number(rest[0].slice(1)));
      if (!hit) throw new Error(`${rest[0]} is no decision of ${slug}`);
      console.log(`${hit.line}\n  in ${hit.file}${hit.pointer ? `\n  -> ${hit.pointer}` : ''}`);
      return;
    }
    const named = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
    const slug = named || resolveTask(cwd, { task: flag(rest, '--task') });
    if (!slug) { console.log(`no task bound: ${unboundReason(cwd)}`); return; }
    const task = readTask(cwd, slug);
    if (!task) throw new Error(`no task ${slug}`);
    console.log(taskStatus(task, {
      ...(distill ? { undistilled: distillStatus(cwd, slug).undistilled } : {}),
      ...(decisionsFlag !== null ? { decisions: Number(decisionsFlag) } : {}),
    }));
    const kept = keptEventsText(slug);
    if (kept) console.log(kept);
  } else if (verb === 'show') {
    const slug = args[0] || bound(args);
    const dir = readTask(cwd, slug)?.dir || findArchivedTask(cwd, slug);
    if (!dir) throw new Error(`no task ${slug}`);
    process.stdout.write(readFileSync(join(dir, 'TASK.md'), 'utf8'));
    process.stdout.write('\n' + journalText(dir));
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
