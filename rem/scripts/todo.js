#!/usr/bin/env node
// todo.js — the /todo CLI over the one backlog (logic in todo-lib.mjs).
//
//   todo.js [report] [--module <m>] [--severity]   read-only: task open items, the backlog, stale docs
//   todo.js add "<summary>" [--severity HIGH|MEDIUM|LOW] [--module <m>] [--file <path>]
//   todo.js show <id>
//   todo.js close <id> ["<how>"]                   archive the item into memory
//   todo.js adopt <legacy.md>...                   one item file per open checkbox/finding
// With .claude/rem.json {"backlog": "issues"}, add/close/adopt are refused: the tracker is the store.

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMain } from '../shared/lib.mjs';
import { addItem, closeItem, adoptLegacy, formatReport, todoDir, backlogMode } from './todo-lib.mjs';

const PREFIX = '[todo]';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? null;
}

export function main(argv) {
  const args = [...argv];
  const verb = args[0] && !args[0].startsWith('--') ? args.shift() : 'report';
  if (verb === 'report') {
    const moduleFilter = flag(args, '--module');
    const sortBySeverity = args.includes('--severity');
    console.log(formatReport(cwd, { moduleFilter, sortBySeverity }));
  } else if (verb === 'add') {
    const severity = flag(args, '--severity') || 'MEDIUM';
    const module = flag(args, '--module') || 'general';
    const file = flag(args, '--file') || '';
    const { id } = addItem(cwd, args.join(' '), { severity, module, file });
    console.log(`${PREFIX} added ${id} → .claude/todo/${id}.md`);
  } else if (verb === 'show') {
    process.stdout.write(readFileSync(join(todoDir(cwd), `${args[0]}.md`), 'utf8'));
  } else if (verb === 'close') {
    if (backlogMode(cwd) === 'issues' && !/^O\d+$/.test(args[0] || '')) throw new Error('this repo\'s backlog is the issue tracker — close the issue there');
    const [id, ...how] = args;
    console.log(`${PREFIX} closed ${id} → ${closeItem(cwd, id, how.join(' '))}`);
  } else if (verb === 'adopt') {
    const ids = adoptLegacy(cwd, args);
    console.log(`${PREFIX} adopted ${ids.length} open item(s)${ids.length ? `: ${ids.join(', ')}` : ''}`);
  } else {
    throw new Error('usage: todo.js [report|add|show|close|adopt] (see the header)');
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`${PREFIX} ${e.message}`); process.exitCode = 1; }
}
