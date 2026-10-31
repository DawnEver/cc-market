// tasks.mjs — the tasks layer: what is being done, and how far.
//
// A task is a directory .claude/tasks/<slug>/ at the project root:
//   TASK.md     goal, scope, owner, status — written only by the user's /rem:task command
//   JOURNAL.md  append-only: dated progress, decisions Dn, open items On, handoffs
// Only the user opens or closes a task (hooks/task-guard.js refuses an agent). A session
// works on ONE task, bound by the user's instruction (--task) or by its worktree/branch
// name, and appends only to that task's journal.

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync } from 'fs';
import { join, basename, dirname } from 'path';
import { findProjectRoot, todayISO } from '../shared/lib.mjs';
import { spawnSync } from '../shared/spawn.mjs';
import { parseFrontmatter, findAllScopes, listEntries } from './lib.mjs';
import { collectBoundDocs } from './doc-freshness.js';

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function tasksDir(start) {
  return join(findProjectRoot(start), '.claude', 'tasks');
}

const taskFile = (start, slug) => join(tasksDir(start), slug, 'TASK.md');
const journalFile = (start, slug) => join(tasksDir(start), slug, 'JOURNAL.md');

// ── Journal lines: `- <date> <tag>: <text>` ──
//   opened | progress | D<n> | O<n> open | O<n> closed | handoff | closed
const LINE_RE = /^- (\d{4}-\d{2}-\d{2}) (opened|progress|handoff|closed|D(\d+)|O(\d+) (open|closed)): (.*)$/;

export function parseJournal(text) {
  const decisions = [];
  const items = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    if (m[3]) decisions.push({ n: Number(m[3]), date: m[1], text: m[6] });
    if (m[4]) {
      const n = Number(m[4]);
      if (m[5] === 'open') items.set(n, { n, date: m[1], text: m[6], open: true });
      else if (items.has(n)) items.get(n).open = false;
    }
  }
  return { decisions, items: [...items.values()] };
}

export function readTask(start, slug) {
  const file = taskFile(start, slug);
  if (!SLUG_RE.test(slug) || !existsSync(file)) return null;
  const { fields } = parseFrontmatter(readFileSync(file, 'utf8'));
  const journal = existsSync(journalFile(start, slug)) ? readFileSync(journalFile(start, slug), 'utf8') : '';
  const { decisions, items } = parseJournal(journal);
  return {
    slug,
    goal: (fields.description || '').replace(/^"|"$/g, ''),
    status: fields.status || 'open',
    opened_by: fields.opened_by || null,
    owner: fields.owner || null,
    created: fields.created || null,
    scope: (fields.scope || '').split(',').map(s => s.trim()).filter(Boolean),
    decisions,
    items,
    openItems: items.filter(i => i.open),
    dir: join(tasksDir(start), slug),
  };
}

export function listTasks(start) {
  const dir = tasksDir(start);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => readTask(start, e.name))
    .filter(Boolean)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function gitBranch(cwd) {
  const r = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// The ONE open task a session in `start` works on: the user's explicit --task, else the
// worktree directory name, else the branch's last segment (pr/<slug>, lane/<slug>, ...).
// null when none names an open task — nothing is guessed beyond that.
export function resolveTask(start, { task } = {}) {
  const open = slug => readTask(start, slug)?.status === 'open';
  if (task) return open(task) ? task : null;
  const root = findProjectRoot(start);
  const candidates = [basename(root), gitBranch(root).split('/').pop()];
  return candidates.find(s => s && SLUG_RE.test(s) && open(s)) || null;
}

// ── Writes (task.js is the only caller) ──

export function openTask(start, slug, goal, { scope = [], owner = 'user', date = todayISO() } = {}) {
  if (!SLUG_RE.test(slug)) throw new Error(`task slug must be kebab-case, got: ${slug}`);
  if (!goal || /[\r\n]/.test(goal)) throw new Error('a task needs a one-line goal');
  if (existsSync(taskFile(start, slug))) throw new Error(`task ${slug} exists`);
  mkdirSync(join(tasksDir(start), slug), { recursive: true });
  writeFileSync(taskFile(start, slug), [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(goal)}`,
    'kind: task',
    `task: ${slug}`,
    'opened_by: user',
    `owner: ${owner}`,
    `created: ${date}`,
    'status: open',
    ...(scope.length ? [`scope: ${scope.join(', ')}`] : []),
    '---',
    '',
    `# ${slug}`,
    '',
    `Goal: ${goal}`,
    '',
    'Progress, decisions (Dn), open items (On) and handoffs are in JOURNAL.md (append-only).',
    '',
  ].join('\n'), { flag: 'wx' });
  appendJournal(start, slug, 'opened', goal, { date, allowClosed: true });
}

// Append ONE line. O_APPEND: earlier bytes are never rewritten.
export function appendJournal(start, slug, tag, text, { date = todayISO(), allowClosed = false } = {}) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open' && !allowClosed) throw new Error(`task ${slug} is ${task.status}; its journal is final`);
  if (!text || /[\r\n]/.test(text)) throw new Error('a journal line is one line of text');
  let label = tag;
  if (tag === 'decision') label = `D${task.decisions.length + 1}`;
  else if (tag === 'open-item') label = `O${Math.max(0, ...task.items.map(i => i.n)) + 1} open`;
  else if (tag.startsWith('close-item:')) {
    const n = Number(tag.slice('close-item:'.length).replace(/^O/, ''));
    if (!task.openItems.some(i => i.n === n)) throw new Error(`O${n} is not an open item of ${slug}`);
    label = `O${n} closed`;
  }
  const line = `- ${date} ${label}: ${text}\n`;
  if (!LINE_RE.test(line.trimEnd())) throw new Error(`bad journal tag: ${tag}`);
  appendFileSync(journalFile(start, slug), line, 'utf8');
  return line.trimEnd();
}

// Status is the one TASK.md field that moves after open; only the user's command moves it.
function setTaskStatus(start, slug, status) {
  const file = taskFile(start, slug);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/^status: .*$/m, `status: ${status}`), 'utf8');
}

// ── Close: distill, then archive into memory ──
//
// A decision Dn is DISTILLED when something outside the journal cites
// `tasks/<slug>/JOURNAL.md#Dn`: a memory entry (`from:` or its body), a rule under
// .claude/rules/, or a bound doc. Distilled knowledge lives on in its new home; the
// archived journal stays the record.

function filesUnder(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) filesUnder(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function distillStatus(start, slug) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  const root = findProjectRoot(start);
  const cite = new RegExp(`tasks/${slug}/JOURNAL\\.md#D(\\d+)\\b`, 'g');
  const cited = new Set();
  const homes = [
    ...findAllScopes(root).flatMap(s => filesUnder(join(s, '.claude', 'memory'))),
    ...filesUnder(join(root, '.claude', 'rules')),
    ...collectBoundDocs(root).map(d => d.full),
  ];
  for (const file of homes) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.replace(/\\/g, '/').matchAll(cite)) cited.add(Number(m[1]));
  }
  return {
    undistilled: task.decisions.map(d => d.n).filter(n => !cited.has(n)),
    openItems: task.openItems.map(i => i.n),
  };
}

// Close = refuse until distilled, record the close, then ARCHIVE: the task directory
// moves (git mv; a plain rename outside git) to .claude/memory/<close-date>/task-<slug>/.
// `journalOnly` names decisions the user keeps only in the archived journal.
export function closeTask(start, slug, reason, { journalOnly = [], date = todayISO() } = {}) {
  const task = readTask(start, slug);
  if (!task || task.status !== 'open') throw new Error(`no open task ${slug}`);
  const { undistilled, openItems } = distillStatus(start, slug);
  if (openItems.length) throw new Error(`${openItems.map(n => `O${n}`).join(', ')} ${openItems.length === 1 ? 'is' : 'are'} open — close or carry each item before closing the task`);
  const keep = new Set(journalOnly.map(s => Number(String(s).replace(/^D/, ''))));
  const missing = undistilled.filter(n => !keep.has(n));
  if (missing.length) {
    throw new Error(`${missing.map(n => `D${n}`).join(', ')} not distilled — cite tasks/${slug}/JOURNAL.md#Dn from a memory entry `
      + '(remember.js --from), a rule or a bound doc, or keep them in the journal only (--journal-only D<n>,...)');
  }
  const kept = [...keep].sort((a, b) => a - b).map(n => `D${n}`);
  appendJournal(start, slug, 'closed', `${reason || 'closed by the user'}${kept.length ? ` (kept in the journal only: ${kept.join(', ')})` : ''}`, { date });
  setTaskStatus(start, slug, 'closed');

  const root = findProjectRoot(start);
  const [y, m, d] = date.split('-');
  const dest = join(root, '.claude', 'memory', y, m, d, `task-${slug}`);
  if (existsSync(dest)) throw new Error(`${dest} exists`);
  mkdirSync(dirname(dest), { recursive: true });
  const moved = spawnSync('git', ['mv', task.dir, dest], { cwd: root, encoding: 'utf8' });
  if (moved.status !== 0) renameSync(task.dir, dest); // untracked or no git: a plain move
  return dest;
}

// An archived task: .claude/memory/<date>/task-<slug>/ in any scope.
export function findArchivedTask(start, slug) {
  const root = findProjectRoot(start);
  for (const scope of findAllScopes(root)) {
    const hit = listEntries(scope).find(e => e.kind === 'task' && e.task === slug);
    if (hit) return join(scope, '.claude', 'memory', hit.path);
  }
  return null;
}
