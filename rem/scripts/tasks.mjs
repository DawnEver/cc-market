// tasks.mjs — the tasks layer: what is being done, and how far.
//
// A task is a directory .claude/tasks/<slug>/ at the project root:
//   TASK.md     goal, scope, owner, status — written only by the user's /rem:task command
//   JOURNAL.md  append-only: dated progress, decisions Dn, open items On, handoffs
// Opening/closing needs the user's authority record (authority.mjs): refused by default,
// detectable when bypassed, not preventable by the same OS user. A session
// works on ONE task, bound by the user's instruction (--task) or by the user's `task: <slug>`
// prompt (recorded by dev-lab, read here), and appends only to that task's journal.

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { findProjectRoot, todayISO } from '../shared/lib.mjs';
import { spawnSync } from '../shared/spawn.mjs';
import { parseFrontmatter, findAllScopes, listEntries, assertLanguage, findForeignScript } from './lib.mjs';
import { collectBoundDocs } from './doc-freshness.js';
import { consumeAuthority, authorityProblem } from './authority.mjs';

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
    authority: fields.authority || null,
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

// The main checkout of the repository at `start` (where its tasks live, from any worktree).
export function mainCheckout(start) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: findProjectRoot(start), encoding: 'utf8' });
  return r.status === 0 ? dirname(r.stdout.trim()) : findProjectRoot(start);
}

// The door that binds a session, named wherever none is bound (dev_lab.dev.taskbinding.DOOR).
export const BIND_DOOR = 'the user binds this session with a prompt whose first line is `task: <slug>` '
  + '(an open task; a new one is opened by the user with /rem:task open <slug> "<goal>")';

// `python -m dev_lab.dev.taskbinding status` prints `task <slug>@<authority>` or `no task bound: ...`.
export function parseBindingStatus(text) {
  const m = String(text || '').trim().match(/^task ([^@\s]+)@(\S+)$/);
  return m && SLUG_RE.test(m[1]) ? { slug: m[1], authority: m[2] } : null;
}

// The checkout's own venv python (the family doors' `.venv/Scripts/python.exe | .venv/bin/python`), or null.
function devLabPython(root) {
  return [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python')].find(existsSync) || null;
}

// The session's binding as dev-lab records it (rem never writes it), or null when none is
// bound or dev-lab cannot be asked — never guessed.
export function readSessionBinding(start) {
  const root = mainCheckout(start);
  const python = devLabPython(root);
  if (!python) return null;
  const r = spawnSync(python, ['-m', 'dev_lab.dev.taskbinding', 'status'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? parseBindingStatus(r.stdout) : null;
}

// The ONE open task a session in `start` works on: the user's explicit --task, else the task
// the user bound the session to (`task: <slug>`, read by `binding`), valid only while that
// task is open under the main checkout with the same authority. null otherwise.
export function resolveTask(start, { task, binding = readSessionBinding } = {}) {
  if (task) return readTask(start, task)?.status === 'open' ? task : null;
  const bound = binding(start);
  if (!bound) return null;
  const found = readTask(mainCheckout(start), bound.slug);
  return found?.status === 'open' && found.authority === bound.authority ? bound.slug : null;
}

// ── Writes (task.js is the only caller) ──

export function openTask(start, slug, goal, { scope = [], owner = 'user', date = todayISO() } = {}) {
  if (!SLUG_RE.test(slug)) throw new Error(`task slug must be kebab-case, got: ${slug}`);
  if (!goal || /[\r\n]/.test(goal)) throw new Error('a task needs a one-line goal');
  assertLanguage(start, goal, 'the task goal');
  if (existsSync(taskFile(start, slug))) throw new Error(`task ${slug} exists`);
  const authority = consumeAuthority(start, 'open', slug); // the user's /rem:task prompt grants it
  mkdirSync(join(tasksDir(start), slug), { recursive: true });
  writeFileSync(taskFile(start, slug), [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(goal)}`,
    'kind: task',
    `task: ${slug}`,
    'opened_by: user',
    `authority: ${authority}`,
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
  appendJournal(start, slug, 'opened', `${goal} (authority ${authority})`, { date, allowClosed: true });
}

// Append ONE line. O_APPEND: earlier bytes are never rewritten.
export function appendJournal(start, slug, tag, text, { date = todayISO(), allowClosed = false } = {}) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open' && !allowClosed) throw new Error(`task ${slug} is ${task.status}; its journal is final`);
  if (!text || /[\r\n]/.test(text)) throw new Error('a journal line is one line of text');
  assertLanguage(start, text, 'the journal line');
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

// The ONE sanctioned rewrite of a journal line: translating it into English. Line n (1-based)
// must be a journal line holding foreign script; the replacement must hold none and keep the
// `- <date> <tag>: ` prefix byte-identical. One audit line is then appended. Nothing else moves.
export function translateJournalLine(start, slug, n, replacement, { date = todayISO() } = {}) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open') throw new Error(`task ${slug} is ${task.status}; its journal is final`);
  const file = journalFile(start, slug);
  const lines = readFileSync(file, 'utf8').split('\n');
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) throw new Error(`line ${n} is not in ${slug}'s journal`);
  const eol = lines[i].endsWith('\r') ? '\r' : '';
  const old = lines[i].slice(0, lines[i].length - eol.length);
  const m = old.match(LINE_RE);
  if (!m) throw new Error(`line ${n} is not a journal line`);
  if (!findForeignScript(old).length) {
    throw new Error(`line ${n} holds no foreign-script text; only a translation may rewrite a journal line`);
  }
  if (!replacement || /[\r\n]/.test(replacement)) throw new Error('a journal line is one line of text');
  const prefix = old.slice(0, old.length - m[6].length);
  if (!replacement.startsWith(prefix) || !LINE_RE.test(replacement)) {
    throw new Error(`the translation must keep the prefix byte-identical: "${prefix}"`);
  }
  const bad = findForeignScript(replacement);
  if (bad.length) {
    const cp = c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    throw new Error(`the translation still holds non-English script (${bad.slice(0, 8).map(c => `${cp(c)} ${c}`).join(', ')})`);
  }
  lines[i] = replacement + eol;
  writeFileSync(file, lines.join('\n'), 'utf8');
  return appendJournal(start, slug, 'progress', `line ${n} translated to English`, { date });
}

// The EXCEPTIONAL rewrite (user ruling 2026-11-13): a journal line that is WRONG -- a misstated
// fact, a mistranslated quote -- is corrected in place, but only with a reason and the user's
// words approving it. The `- <date> <tag>: ` prefix stays byte-identical, and one audit line
// records the reason, the approval and the old line's digest. A changed MIND is a new decision,
// never an amendment: this is for content that is wrong as written.
export function amendJournalLine(start, slug, n, replacement, { reason, approved, date = todayISO() } = {}) {
  if (!reason || !reason.trim()) throw new Error('an amendment names its reason (--reason)');
  if (!approved || !approved.trim()) throw new Error('an amendment quotes the user approving it (--approved)');
  if (/[\r\n"]/.test(reason + approved)) throw new Error('the reason and the approval are one line each, without "');
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open') throw new Error(`task ${slug} is ${task.status}; its journal is final`);
  const file = journalFile(start, slug);
  const lines = readFileSync(file, 'utf8').split('\n');
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) throw new Error(`line ${n} is not in ${slug}'s journal`);
  const eol = lines[i].endsWith('\r') ? '\r' : '';
  const old = lines[i].slice(0, lines[i].length - eol.length);
  const m = old.match(LINE_RE);
  if (!m) throw new Error(`line ${n} is not a journal line`);
  if (!replacement || /[\r\n]/.test(replacement)) throw new Error('a journal line is one line of text');
  const prefix = old.slice(0, old.length - m[6].length);
  if (!replacement.startsWith(prefix) || !LINE_RE.test(replacement) || replacement === old) {
    throw new Error(`the amendment must keep the prefix byte-identical ("${prefix}") and change the text`);
  }
  assertLanguage(start, replacement, 'the amended line');
  const digest = createHash('sha256').update(old).digest('hex').slice(0, 12);
  lines[i] = replacement + eol;
  writeFileSync(file, lines.join('\n'), 'utf8');
  return appendJournal(start, slug, 'progress',
    `line ${n} amended: ${reason.trim()} -- approved: "${approved.trim()}" (was sha256:${digest})`, { date });
}

// Status is the one TASK.md field that moves after open; the user's close command moves it.
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
  // Everything is validated before the first write: a refused close changes nothing.
  const root = findProjectRoot(start);
  const [y, m, d] = date.split('-');
  const dest = join(root, '.claude', 'memory', y, m, d, `task-${slug}`);
  if (existsSync(dest)) throw new Error(`${dest} exists — the task stays open`);
  const kept = [...keep].sort((a, b) => a - b).map(n => `D${n}`);
  const line = `${reason || 'closed by the user'}${kept.length ? ` (kept in the journal only: ${kept.join(', ')})` : ''}`;
  if (/[\r\n]/.test(line)) throw new Error('a close reason is one line');
  const authority = consumeAuthority(start, 'close', slug); // the user's /rem:task prompt grants it

  appendJournal(start, slug, 'closed', `${line} (authority ${authority})`, { date });
  setTaskStatus(start, slug, 'closed');
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

// Place an OPEN task of this checkout into the main checkout, where dev-lab's binding reads it
// (cc-market #18: a worktree's task was unreachable when main lacked it, and no door remained).
// It copies the user's record verbatim and opens nothing: the task must be open here with an
// authority the local history does not contradict. The main checkout gets it only when absent or
// byte-identical; a differing copy is refused, never overwritten. Returns what it did.
export function placeTask(start, slug, { main = mainCheckout(start) } = {}) {
  const task = readTask(start, slug);
  if (task?.status !== 'open') throw new Error(`no open task ${slug} in this checkout: place copies an open task, it never opens one`);
  const problem = authorityProblem(start, slug, task.authority);
  if (problem?.level === 'error') throw new Error(`task ${slug} cannot be placed: ${problem.msg}`);
  const here = join(tasksDir(start), slug);
  const there = join(main, '.claude', 'tasks', slug);
  if (here === there) return `task ${slug} is already in the main checkout`;
  const files = ['TASK.md', 'JOURNAL.md'].filter(f => existsSync(join(here, f)));
  const differing = files.filter(f => existsSync(join(there, f))
    && readFileSync(join(there, f), 'utf8') !== readFileSync(join(here, f), 'utf8'));
  if (differing.length) {
    throw new Error(`the main checkout holds a different ${differing.join(' and ')} for ${slug}: refused, never overwritten`
      + ' -- the user decides which record stands');
  }
  const missing = files.filter(f => !existsSync(join(there, f)));
  if (!missing.length) return `task ${slug} is already placed in the main checkout`;
  mkdirSync(there, { recursive: true });
  for (const f of missing) writeFileSync(join(there, f), readFileSync(join(here, f), 'utf8'));
  return `placed ${slug} (${missing.join(', ')}) in ${there}`;
}

// The opposite direction of place: the user's /rem:task open writes the record into the MAIN
// checkout, untracked, and only the session bound to the task may commit it on its own
// pr/<slug>/<feature> branch -- from its worktree, where the task guard refuses every other
// write into .claude/tasks. This copies the open task's TASK.md and JOURNAL.md byte for byte
// into the worktree at `start`, so that session can `git add` them. It opens nothing; it refuses
// a task not open in the main checkout, a session not bound to it (`binding`, as resolveTask
// reads it), and a worktree holding a different copy. Returns what it did.
export function commitRecord(start, slug, { main = mainCheckout(start), binding = readSessionBinding } = {}) {
  const task = SLUG_RE.test(slug || '') ? readTask(main, slug) : null;
  if (task?.status !== 'open') {
    throw new Error(`no open task ${slug} in the main checkout: commit-record copies an open task, it never opens one`);
  }
  const bound = binding(start);
  if (bound?.slug !== slug || bound.authority !== task.authority) {
    throw new Error(`this session is not bound to task ${slug}: only its bound session commits its record; ${BIND_DOOR}`);
  }
  const here = join(tasksDir(start), slug);
  if (here === task.dir) {
    throw new Error(`this is the main checkout: commit ${slug}'s record from the bound session's worktree, on pr/${slug}/<feature>`);
  }
  const files = ['TASK.md', 'JOURNAL.md'].filter(f => existsSync(join(task.dir, f)));
  const differing = files.filter(f => existsSync(join(here, f))
    && !readFileSync(join(here, f)).equals(readFileSync(join(task.dir, f))));
  if (differing.length) {
    throw new Error(`this worktree holds a different ${differing.join(' and ')} for ${slug}: refused, never overwritten`
      + ' -- the user decides which record stands');
  }
  const missing = files.filter(f => !existsSync(join(here, f)));
  if (!missing.length) return `this worktree already holds ${slug}'s record: git add .claude/tasks/${slug} and commit it`;
  mkdirSync(here, { recursive: true });
  for (const f of missing) writeFileSync(join(here, f), readFileSync(join(task.dir, f)));
  return `copied ${slug} (${missing.join(', ')}) into ${here}: git add .claude/tasks/${slug} and commit it on pr/${slug}/<feature>`;
}
