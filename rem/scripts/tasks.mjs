// tasks.mjs — the tasks layer: what is being done, and how far.
//
// A task is a directory <slug>/ of the repository's task LEDGER (tasksDir):
//   TASK.md     goal, scope, owner, status — written only by the user's /rem:task command
//   JOURNAL.md  append-only: dated progress, decisions Dn, open items On, handoffs
// Opening/closing needs the user's authority record (authority.mjs): refused by default,
// detectable when bypassed, not preventable by the same OS user. A session
// works on ONE task, bound by the user's instruction (--task) or by the user's `task: <slug>`
// prompt (bindSession, run by rem's UserPromptSubmit hook hooks/task-authority.js), and appends
// only to that task's journal.
//
// The ledger is REPO state, not branch state (cc-market #20): ONE directory, <main checkout>/.claude/tasks/,
// the parent of `git rev-parse --git-common-dir`, the same from every worktree, so a task opened in one
// worktree is found from all of them. It is never committed on a feature branch; close archives a task into
// memory, which is. A session's binding is SESSION state (D34): one file in the machine home naming the
// ledger its task lives in (session-binding.mjs), so every repo reads the same binding.

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, statSync, realpathSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { createHash } from 'crypto';
import { findProjectRoot, todayISO } from '../shared/lib.mjs';
import { spawnSync } from '../shared/spawn.mjs';
import { withLock } from '../shared/lock.mjs';
import { atomicWriteFile } from '../shared/atomic-write.mjs';
import { parseFrontmatter, setField, listEntries, assertLanguage, findForeignScript } from './lib.mjs';
import { collectBoundDocs } from './doc-freshness.js';
import { consumeAuthority, authorityProblem } from './authority.mjs';
import { writeBinding, readBinding, ledgerOf, sameLedger, retiredBinding, bindingFile, recordLedger, knownLedgers, MIGRATE_BINDINGS_DOOR } from './session-binding.mjs';
import { forgeCommand, findTaskIssues, openTaskIssue, closeTaskIssue, issueNumber, label } from './task-forge.mjs';

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A NEED is a test resource name the repo maps to the extra that serves it (dev-lab depneeds, D79): a task
// declares needs, never extras. The one frontmatter shape dev-lab reads is `needs: [a, b]`.
export const NEED_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function parseNeeds(value) {
  const names = String(value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const bad = names.filter(n => !NEED_RE.test(n));
  if (bad.length) throw new Error(`needs must be need names (e.g. simba, windows), got: ${bad.join(', ')}`);
  return [...new Set(names)];
}

function readNeedsField(value) {
  if (!value) return [];
  if (!value.startsWith('[') || !value.endsWith(']')) throw new Error(`needs must be a [a, b] list, got: ${value}`);
  return parseNeeds(value.slice(1, -1));
}
const needsLine = needs => `[${needs.join(', ')}]`;

// THE ONE answer to "which checkout holds the ledger": the main checkout of the repository at
// `start`, from any of its worktrees (its own root outside git) -- the parent of git's common dir,
// read from the files git keeps (.git, or a worktree's gitdir and its commondir) so the per-prompt
// path spawns nothing; git itself answers only a layout those files do not explain. Cached per root.
const checkouts = new Map();
export function mainCheckout(start) {
  const root = findProjectRoot(start);
  if (!checkouts.has(root)) checkouts.set(root, canonical(mainCheckoutOf(root)));
  return checkouts.get(root);
}

// One spelling per directory: git reports a worktree's common dir in long form while a Windows temp path may arrive
// as an 8.3 short name (RUNNER~1), so the ledger path is canonicalised once, here.
const canonical = p => { try { return realpathSync.native(p); } catch { return p; } };

function mainCheckoutOf(root) {
  try {
    const dotGit = join(root, '.git');
    if (statSync(dotGit).isDirectory()) return root;
    const gitDir = resolve(root, readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
    const common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    if (basename(common) === '.git') return dirname(common);
  } catch { /* not a plain checkout or worktree: ask git */ }
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? dirname(r.stdout.trim()) : root;
}

// THE ONE RESOLVER of the task ledger: every read and write goes through it. A git-side reader (another tool's hook)
// derives the same directory from git (skills/rem/reference/tasks.md § The binding file).
export function tasksDir(start) {
  return join(mainCheckout(start), '.claude', 'tasks');
}

// The environment keys a native harness names its session id in, as a git hook run inside that session sees it.
export const SESSION_ENV = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'ANTIGRAVITY_CONVERSATION_ID'];
// A session id is a plain id, never a path: it names the binding file.
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
// The user's binding prompt: its FIRST line is exactly `task: <slug>`.
const BIND_PROMPT_RE = /^[ \t]*task:[ \t]*([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*(?:\r?\n|$)/;

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

// IDs a journal mints more than once (a Dn line, or an `On open` line, seen twice).
export function duplicateIds(text) {
  const seen = new Set(), dup = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    const id = m?.[3] ? `D${m[3]}` : m?.[5] === 'open' ? `O${m[4]}` : null;
    if (id && seen.has(id)) dup.add(id);
    if (id) seen.add(id);
  }
  return [...dup];
}

export function readTask(start, slug) {
  const file = taskFile(start, slug);
  if (!SLUG_RE.test(slug) || !existsSync(file)) return null;
  const { fields } = parseFrontmatter(readFileSync(file, 'utf8'));
  const { decisions, items } = parseJournal(journalText(join(tasksDir(start), slug)));
  return {
    slug,
    goal: (fields.description || '').replace(/^"|"$/g, ''),
    status: fields.status || 'open',
    opened_by: fields.opened_by || null,
    authority: fields.authority || null,
    issue: fields.issue || null,
    owner: fields.owner || null,
    created: fields.created || null,
    scope: (fields.scope || '').split(',').map(s => s.trim()).filter(Boolean),
    needs: readNeedsField(fields.needs),
    decisions,
    items,
    openItems: items.filter(i => i.open),
    dir: join(tasksDir(start), slug),
  };
}

// ── Chapters: the journal's older lines, moved verbatim by `task.js distill` ──
// <task>/chapters/<date>.md holds that date's lines; chapters/distilled.md holds decisions an agent's plan
// distilled, each followed by its pointer. Every Dn/On keeps its id: the whole journal is the chapters
// (oldest first) followed by JOURNAL.md, so numbering, items and lookups read one record.
export const CHAPTERS = 'chapters';
export const DISTILLED = 'distilled.md';
export const KEEP_DECISIONS = 3;
const DAY_MS = 86400000;
function chapterFiles(dir) {
  const at = join(dir, CHAPTERS);
  if (!existsSync(at)) return [];
  return readdirSync(at).filter(f => f.endsWith('.md')).sort().map(f => join(at, f));
}
export function journalText(dir) {
  const read = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  return [...chapterFiles(dir), join(dir, 'JOURNAL.md')].map(read).join('\n');
}

// Where decision Dn lives now: JOURNAL.md, chapters/<date>.md, or chapters/distilled.md (with its pointer).
export function findDecision(start, slug, n) {
  const dir = join(tasksDir(start), slug);
  for (const file of [join(dir, 'JOURNAL.md'), ...chapterFiles(dir)]) {
    let lines;
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
    const i = lines.findIndex(l => l.match(LINE_RE)?.[3] === String(n));
    if (i < 0) continue;
    return { file, line: lines[i], pointer: lines[i + 1]?.match(/^ {2}-> (.*)$/)?.[1] ?? null };
  }
  return null;
}

// MECHANICAL distill, deterministic: every JOURNAL.md line dated before `before` (default: `keepDays` before
// `date`) moves verbatim to chapters/<its date>.md, except the `opened` line, the open line of a still-open
// item and the newest `keep` decisions. It judges nothing; distillByPlan applies an agent's judgment.
export function distillJournal(start, slug, { keep = KEEP_DECISIONS, keepDays = 14, before, date = todayISO() } = {}) {
  const cut = before || new Date(Date.parse(date) - keepDays * DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cut)) throw new Error(`--before needs YYYY-MM-DD, got ${cut}`);
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`--keep needs a whole number of decisions, got ${keep}`);
  return withLock(journalFile(start, slug), () => {
    const task = readTask(start, slug);
    if (!task) throw new Error(`no task ${slug}`);
    const open = new Set(task.openItems.map(i => i.n));
    const live = new Set(keep ? task.decisions.slice(-keep).map(d => d.n) : []);
    const stays = [], moved = new Map();
    for (const line of readFileSync(journalFile(start, slug), 'utf8').split(/\r?\n/)) {
      const m = line.match(LINE_RE);
      const held = !m || m[1] >= cut || m[2] === 'opened' || (m[3] && live.has(Number(m[3])))
        || (m[5] === 'open' && open.has(Number(m[4])));
      if (held) { stays.push(line); continue; }
      if (!moved.has(m[1])) moved.set(m[1], []);
      moved.get(m[1]).push(line);
    }
    const dir = join(task.dir, CHAPTERS);
    if (moved.size) mkdirSync(dir, { recursive: true });
    for (const [day, lines] of moved) appendFileSync(join(dir, `${day}.md`), lines.join('\n') + '\n', 'utf8');
    atomicWriteFile(journalFile(start, slug), stays.join('\n'));
    const n = [...moved.values()].reduce((a, l) => a + l.length, 0);
    return `moved ${n} line(s) dated before ${cut} into ${moved.size} chapter(s) under ${dir}`;
  });
}

// SEMANTIC distill, applied: `plan` is an agent's judgment, {"distill":[{"id":"D12","pointer":"<rule id or memory
// path>"}]}. Each named decision's line moves verbatim to chapters/distilled.md with its pointer, and JOURNAL.md
// records the move. Validated first: an unknown id, a missing pointer or a repeat refuses the whole plan by name.
export function distillByPlan(start, slug, plan, { date = todayISO() } = {}) {
  const rows = plan?.distill;
  if (!Array.isArray(rows) || !rows.length) throw new Error('a distill plan is {"distill":[{"id":"D<n>","pointer":"<where it is captured>"}]}');
  return withLock(journalFile(start, slug), () => {
    const task = readTask(start, slug);
    if (!task) throw new Error(`no task ${slug}`);
    const seen = new Set();
    const found = rows.map(r => {
      const n = Number(String(r?.id ?? '').match(/^D(\d+)$/)?.[1]);
      if (!n || !task.decisions.some(d => d.n === n)) throw new Error(`plan names ${r?.id}, which is no decision of ${slug}`);
      if (seen.has(n)) throw new Error(`plan names D${n} twice`);
      seen.add(n);
      const pointer = String(r.pointer ?? '').trim();
      if (!pointer || /[\r\n]/.test(pointer)) throw new Error(`plan row D${n} needs a one-line pointer to where it is captured`);
      const at = findDecision(start, slug, n);
      if (at.file.endsWith(DISTILLED)) throw new Error(`D${n} is already distilled (-> ${at.pointer})`);
      return { n, pointer, at };
    });
    const dir = join(task.dir, CHAPTERS);
    mkdirSync(dir, { recursive: true });
    const byFile = new Map();
    for (const f of found) { if (!byFile.has(f.at.file)) byFile.set(f.at.file, new Set()); byFile.get(f.at.file).add(f.at.line); }
    for (const [file, drop] of byFile) {
      atomicWriteFile(file, readFileSync(file, 'utf8').split(/\r?\n/).filter(l => !drop.has(l)).join('\n'));
    }
    appendFileSync(join(dir, DISTILLED), found.map(f => `${f.at.line}\n  -> ${f.pointer}`).join('\n') + '\n', 'utf8');
    const ids = found.map(f => `D${f.n}`).join(', ');
    appendJournalLocked(start, slug, 'progress', `distilled ${ids} by plan (${CHAPTERS}/${DISTILLED})`, { date });
    return `distilled ${ids} into ${join(dir, DISTILLED)}`;
  });
}

// ── Progressive disclosure: one line per prompt, status on demand, show for the whole record ──

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 3)}...` : text);
export const SUMMARY_BYTES = 200;
export const STATUS_BYTES = 2048;

// The per-prompt line (<= SUMMARY_BYTES): counts and the newest decision, never item texts.
export function taskSummary(task) {
  const last = task.decisions.at(-1);
  const head = `task ${task.slug}: ${task.openItems.length} open, ${task.decisions.length} decisions`;
  const tail = '; detail: task.js status';
  if (!last) return head + tail;
  const lead = `, last D${last.n} (${last.date.slice(5)}) "`;
  const room = Math.max(0, SUMMARY_BYTES - Buffer.byteLength(head + lead + '"' + tail));
  let text = clip(last.text, Math.min(60, room));
  while (Buffer.byteLength(text) > room) text = text.slice(0, -1);
  return `${head}${lead}${text}"${tail}`;
}

// `task.js status` (<= STATUS_BYTES): goal, scope, authority, open items one line each, the
// newest 3 decisions and the last handoff. `undistilled` (from distillStatus) adds that line.
export function taskStatus(task, { undistilled, decisions: keep = KEEP_DECISIONS } = {}) {
  let journal = '';
  try { journal = readFileSync(join(task.dir, 'JOURNAL.md'), 'utf8'); } catch { /* none yet */ }
  const handoff = journal.split(/\r?\n/).map(l => l.match(LINE_RE)).filter(m => m?.[2] === 'handoff').at(-1);
  const head = [
    `task ${task.slug} (${task.status}, authority ${task.authority || 'none'}, owner ${task.owner || 'user'}): ${clip(task.goal, 300)}`,
    ...(task.scope.length ? [`scope: ${task.scope.join(', ')}`] : []),
  ];
  const tail = [
    `decisions: ${task.decisions.length}${task.decisions.length ? ', newest:' : ''}`,
    ...task.decisions.slice(keep ? -keep : task.decisions.length).map(d => `  D${d.n} (${d.date}) ${clip(d.text, 100)}`),
    ...(chapterFiles(task.dir).length ? [`older lines: ${join(task.dir, CHAPTERS)} (any Dn: task.js status D<n>)`] : []),
    ...(handoff ? [`last handoff (${handoff[1]}): ${clip(handoff[6], 160)}`] : []),
    ...(undistilled ? [`undistilled: ${undistilled.map(n => `D${n}`).join(', ') || '(none)'}`] : []),
    `whole record: task.js show ${task.slug}`,
  ];
  const items = task.openItems.map(i => `  O${i.n} ${clip(i.text, 100)}`);
  let shown = items.length;
  const render = () => [...head, `open items: ${items.length}`, ...items.slice(0, shown),
    ...(shown < items.length ? [`  +${items.length - shown} more (task.js show ${task.slug})`] : []), ...tail].join('\n');
  while (shown > 0 && Buffer.byteLength(render()) > STATUS_BYTES) shown--;
  let out = render();
  while (Buffer.byteLength(out) > STATUS_BYTES) out = out.slice(0, -1); // the cap holds even when the head alone is long
  return out;
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

// Slug and status of every task, reading TASK.md only (no journal): what recall needs per prompt.
export function listTaskHeads(start) {
  const dir = tasksDir(start);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && SLUG_RE.test(e.name) && existsSync(join(dir, e.name, 'TASK.md')))
    .map(e => ({ slug: e.name, status: parseFrontmatter(readFileSync(join(dir, e.name, 'TASK.md'), 'utf8')).fields.status || 'open' }));
}

// The door that binds a session, named wherever none is bound.
export const BIND_DOOR = 'the user binds this session with a prompt whose first line is `task: <slug>` '
  + '(an open task; a new one is opened by the user with /rem:task open <slug> "<goal>")';

// The native session id the harness names in `env`, or ''.
export function sessionOf(env = process.env) {
  return SESSION_ENV.map(k => env[k]).find(v => typeof v === 'string' && SESSION_RE.test(v)) || '';
}

// The slug a user prompt binds the session to -- its FIRST line is exactly `task: <slug>` -- or null.
export function parseBindPrompt(prompt) {
  return String(prompt || '').match(BIND_PROMPT_RE)?.[1] ?? null;
}

// Bind `session` to the OPEN task `slug`: write its one binding file naming the ledger the task was FOUND in
// (findTaskForBinding), never the cwd's, and return the task id `<slug>@<authority>`. Called only by the
// UserPromptSubmit hook, on the USER's prompt. A session started in repo Y so binds a task hosted in repo X
// (D88, cc-market #44). Throws naming the door otherwise.
export function bindSession(start, session, slug, { env = process.env, date = todayISO() } = {}) {
  if (!SESSION_RE.test(String(session || ''))) throw new Error('the harness named no plain session id to bind');
  const { checkout, task } = findTaskForBinding(start, slug, { env, date });
  const id = `${slug}@${task.authority}`;
  writeBinding(session, id, ledgerOf(checkout, tasksDir(checkout)), env);
  return id;
}

const ledgerCheckout = path => String(path).replace(/\\/g, '/').match(/^(.*)\/\.claude\/tasks\/?$/)?.[1] ?? null;
const pathKey = p => { const t = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return /^(win32|darwin)$/.test(process.platform) ? t.toLowerCase() : t; };

// This machine's known main checkouts: `start`'s first, then every checkout whose ledger the machine home records
// (recordLedger, at open and adopt) or a session binding names, each once. Nothing is guessed.
export function knownCheckouts(start, env = process.env) {
  const seen = new Map();
  const add = c => { if (!seen.has(pathKey(c))) seen.set(pathKey(c), c); };
  add(mainCheckout(start));
  let paths = [];
  try { paths = knownLedgers(env); } catch { /* no machine home: this repo only */ }
  for (const checkout of paths.map(ledgerCheckout)) if (checkout && existsSync(checkout)) add(checkout);
  return [...seen.values()];
}

// Record the ledger of `checkout` in the machine home so other repos' sessions find its tasks. No machine home:
// nothing to record into, and binding from this repo itself still works (its cwd is always searched first).
function recordHere(checkout, env = process.env) {
  try { recordLedger(ledgerOf(checkout, tasksDir(checkout)), env); } catch { /* HOME_DOOR is named where a binding needs it */ }
}

// Where `task: <slug>` finds its task: {checkout, task}. This repo's ledger first; then this machine's other known
// ledgers; then the task:<slug> issue on each known repo's forge -- an OPEN one is adopted into that repo's ledger
// here (adoptTask). Refused by name, each with its door: a task not open, a closed issue, more than one open issue,
// no forge door, or nothing anywhere.
export function findTaskForBinding(start, slug, { env = process.env, date = todayISO() } = {}) {
  if (!SLUG_RE.test(String(slug || ''))) throw new Error(`a task slug is kebab-case, got ${slug}`);
  const checkouts = knownCheckouts(start, env);
  const shut = [];
  for (const checkout of checkouts) {
    const task = readTask(checkout, slug);
    if (task?.status === 'open' && task.authority) return { checkout, task };
    if (task) shut.push(`${task.dir} (${task.status})`);
  }
  const ledgers = checkouts.map(c => tasksDir(c)).join(', ');
  if (shut.length) {
    throw new Error(`task ${slug} is not open here: ${shut.join('; ')}. Door: the user opens a new task with `
      + '/rem:task open <slug> "<goal>"');
  }
  try { forgeCommand(env); } catch (unset) {
    throw new Error(`no task ${slug} in this machine's ledgers (${ledgers}), and its forge issue cannot be looked up: ${unset.message}`);
  }
  for (const checkout of checkouts) {
    const issues = findTaskIssues(checkout, slug, env);
    const open = issues.filter(i => String(i.state).toLowerCase() === 'open');
    if (open.length > 1) {
      throw new Error(`the forge of ${checkout} holds ${open.length} open ${label(slug)} issues (${open.map(i => i.url).join(', ')}); `
        + 'a task is ONE issue. Door: the user closes the duplicates, then binds again');
    }
    if (open.length) return { checkout, task: adoptTask(checkout, slug, open[0], { date }) };
    shut.push(...issues.map(i => i.url));
  }
  if (shut.length) {
    throw new Error(`task ${slug} was closed: its issue (${shut.join(', ')}) is not open. Door: the user opens a new `
      + 'task with /rem:task open <slug> "<goal>"');
  }
  throw new Error(`no task ${slug}: no ledger of this machine holds it (${ledgers}) and no ${label(slug)} issue is on `
    + `the forge of ${checkouts.join(', ')}. Door: the user opens it with /rem:task open ${slug} "<goal>" in the repo `
    + `that hosts it, then binds with \`task: ${slug}\``);
}

// This machine's ledger of a task whose identity is the open forge issue `issue` (D88): TASK.md names the issue as
// `issue:` and takes it as its authority (`issue-<n>`); the journal records the adoption. The user's `task:` prompt
// is what adopts it; the issue, opened under the user's authority on the host that opened it, is the task's.
export function adoptTask(checkout, slug, issue, { date = todayISO() } = {}) {
  const goal = String(issue.title || '').replace(/^task:\s*[a-z0-9-]+\s*(?:--\s*)?/, '').replace(/[\r\n]+/g, ' ').trim() || slug;
  mkdirSync(join(tasksDir(checkout), slug), { recursive: true });
  writeFileSync(taskFile(checkout, slug),
    taskHead(slug, goal, { authority: `issue-${issue.number}`, issue: issue.url, owner: 'user', date }), { flag: 'wx' });
  appendJournal(checkout, slug, 'opened', `${goal} (adopted on this machine from ${issue.url})`, { date, allowClosed: true });
  recordHere(checkout);
  return readTask(checkout, slug);
}

function taskHead(slug, goal, { authority, issue, owner, date, scope = [], needs = [] }) {
  return [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(goal)}`,
    'kind: task',
    `task: ${slug}`,
    'opened_by: user',
    `authority: ${authority}`,
    `issue: ${issue}`,
    `owner: ${owner}`,
    `created: ${date}`,
    'status: open',
    ...(scope.length ? [`scope: ${scope.join(', ')}`] : []),
    ...(needs.length ? [`needs: ${needsLine(needs)}`] : []),
    '---',
    '',
    `# ${slug}`,
    '',
    `Goal: ${goal}`,
    '',
    `Identity: ${issue} -- every machine's ledger of this task journals this one issue.`,
    '',
    'Progress, decisions (Dn), open items (On) and handoffs are in JOURNAL.md (append-only).',
    '',
  ].join('\n');
}

// The main checkout of the ledger `session` is bound to when that is another repo's than `start`'s; else null.
// A session started in repo Y and bound to a task of repo X runs that task's journal verbs against X's ledger.
export function boundCheckout(start, { session = sessionOf() } = {}) {
  if (!session || !SESSION_RE.test(session)) return null;
  const bound = readBinding(session);
  if (!bound || sameLedger(bound.ledger, tasksDir(start))) return null;
  const checkout = ledgerCheckout(bound.ledger);
  return checkout && existsSync(checkout) ? checkout : null;
}

// The binding of `session` (default: this process's) as bindSession wrote it -- one file in the machine
// home, read directly, no process spawned -- when it binds a task of the ledger at `start`; null otherwise
// (none bound, or bound to another repo's task: rem's journal verbs act only on this repo's ledger). Never guessed.
export function readSessionBinding(start, { session = sessionOf() } = {}) {
  if (!session || !SESSION_RE.test(session)) return null;
  const bound = readBinding(session);
  return bound && sameLedger(bound.ledger, tasksDir(start)) ? { slug: bound.slug, authority: bound.authority } : null;
}

// Why no task of the ledger at `start` is bound to `session`, with its door: bound in another repo's ledger, still
// in the retired per-repo store (refused by name, never read), or not bound at all.
export function unboundReason(start, { session = sessionOf() } = {}) {
  try { bindingFile('probe'); } catch (unset) { return unset.message; }
  const bound = session && SESSION_RE.test(session) ? readBinding(session) : null;
  if (bound) {
    return `this session is bound to task ${bound.slug}@${bound.authority} of another repo's ledger (${bound.ledger}); `
      + 'its journal verbs run from that repo';
  }
  const old = session ? retiredBinding(tasksDir(start), session) : null;
  if (old) {
    return `session ${session} is bound only in the retired per-repo store ${old}; the one store every repo reads is `
      + `${bindingFile(session)}, which holds none. Door: ${MIGRATE_BINDINGS_DOOR}`;
  }
  return BIND_DOOR;
}

// The ONE open task a session in `start` works on: the user's explicit --task, else the task
// the user bound the session to (`task: <slug>`, read by `binding`), valid only while that
// task is open in the ledger with the same authority. null otherwise.
export function resolveTask(start, { task, binding = readSessionBinding } = {}) {
  if (task) return readTask(start, task)?.status === 'open' ? task : null;
  const bound = binding(start);
  if (!bound) return null;
  const found = readTask(start, bound.slug);
  return found?.status === 'open' && found.authority === bound.authority ? bound.slug : null;
}

// ── Writes (task.js is the only caller) ──

export function openTask(start, slug, goal, { scope = [], needs = [], owner = 'user', date = todayISO() } = {}) {
  const declared = parseNeeds(needs.join(','));
  if (!SLUG_RE.test(slug)) throw new Error(`task slug must be kebab-case, got: ${slug}`);
  if (!goal || /[\r\n]/.test(goal)) throw new Error('a task needs a one-line goal');
  assertLanguage(start, goal, 'the task goal');
  if (existsSync(taskFile(start, slug))) throw new Error(`task ${slug} exists`);
  forgeCommand(); // the identity is a forge issue: no forge door, nothing opens (checked before the authority is spent)
  const authority = consumeAuthority(start, 'open', slug); // the user's /rem:task prompt grants it
  const issue = openTaskIssue(mainCheckout(start), slug, goal);
  mkdirSync(join(tasksDir(start), slug), { recursive: true });
  writeFileSync(taskFile(start, slug), taskHead(slug, goal, { authority, issue: issue.url, owner, date, scope, needs: declared }), { flag: 'wx' });
  appendJournal(start, slug, 'opened', `${goal} (authority ${authority})`, { date, allowClosed: true });
  recordHere(mainCheckout(start));
}

// The bound session amends the task's NEEDS (D79): the one frontmatter line is rewritten and a decision line records
// old and new -- the journal stays append-only, so the record of why lives there.
export function setNeeds(start, slug, needs, { date = todayISO() } = {}) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open') throw new Error(`task ${slug} is ${task.status}; its record is final`);
  const next = parseNeeds(needs);
  const file = taskFile(start, slug);
  const text = readFileSync(file, 'utf8');
  const updated = next.length ? setField(text, 'needs', needsLine(next)) : text.replace(/^needs:.*\r?\n/m, '');
  atomicWriteFile(file, updated);
  return appendJournal(start, slug, 'decision', `needs set to ${needsLine(next)} (was ${needsLine(task.needs)})`, { date });
}

// Append ONE line. O_APPEND: earlier bytes are never rewritten. The read that numbers the line
// and the append run under one lock, and IDs are max+1, so two sessions never mint the same Dn/On.
export function appendJournal(start, slug, tag, text, opts = {}) {
  return withLock(journalFile(start, slug), () => appendJournalLocked(start, slug, tag, text, opts));
}

function appendJournalLocked(start, slug, tag, text, { date = todayISO(), allowClosed = false } = {}) {
  const task = readTask(start, slug);
  if (!task) throw new Error(`no task ${slug}`);
  if (task.status !== 'open' && !allowClosed) throw new Error(`task ${slug} is ${task.status}; its journal is final`);
  if (!text || /[\r\n]/.test(text)) throw new Error('a journal line is one line of text');
  assertLanguage(start, text, 'the journal line');
  let label = tag;
  if (tag === 'decision') label = `D${Math.max(0, ...task.decisions.map(d => d.n)) + 1}`;
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

// One of the two audited rewrites of a journal line (with amend): translating it into English. Line n (1-based)
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
    ...filesUnder(join(root, '.claude', 'memory')),
    ...filesUnder(join(root, '.claude', 'rules')),
    ...collectBoundDocs(root).map(d => d.full),
  ];
  for (const file of homes) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.replace(/\\/g, '/').matchAll(cite)) cited.add(Number(m[1]));
  }
  // A decision a plan distilled (chapters/distilled.md) names where it is captured: it counts as distilled.
  try {
    for (const d of parseJournal(readFileSync(join(task.dir, CHAPTERS, DISTILLED), 'utf8')).decisions) cited.add(d.n);
  } catch { /* nothing distilled by plan */ }
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
  if (task.issue) forgeCommand(); // its identity closes with it: no forge door, the task stays open
  const authority = consumeAuthority(start, 'close', slug); // the user's /rem:task prompt grants it
  if (task.issue) closeTaskIssue(mainCheckout(start), issueNumber(task.issue));

  appendJournal(start, slug, 'closed', `${line} (authority ${authority})`, { date });
  setTaskStatus(start, slug, 'closed');
  mkdirSync(dirname(dest), { recursive: true });
  const moved = spawnSync('git', ['mv', task.dir, dest], { cwd: root, encoding: 'utf8' });
  if (moved.status !== 0) renameSync(task.dir, dest); // untracked or no git: a plain move
  return dest;
}

// An archived task: .claude/memory/<date>/task-<slug>/.
export function findArchivedTask(start, slug) {
  const root = findProjectRoot(start);
  const hit = listEntries(root).find(e => e.kind === 'task' && e.task === slug);
  return hit ? join(root, '.claude', 'memory', hit.path) : null;
}

// Place a task this WORKTREE holds in its own tree (written before the ledger was repo state, or
// committed on a branch) into the ledger, where every worktree finds it (cc-market #18, #20). It
// copies the user's record verbatim and opens nothing: the task must be open there with an
// authority the local history does not contradict. The ledger gets it only when absent or
// byte-identical; a differing copy is refused, never overwritten -- the user decides which record
// stands. Returns what it did.
export function placeTask(start, slug) {
  const here = join(findProjectRoot(start), '.claude', 'tasks', slug);
  const there = join(tasksDir(start), slug);
  if (here === there) return `task ${slug} is already in the ledger`;
  const fields = SLUG_RE.test(slug || '') && existsSync(join(here, 'TASK.md'))
    ? parseFrontmatter(readFileSync(join(here, 'TASK.md'), 'utf8')).fields : null;
  if (fields?.status !== 'open') throw new Error(`no open task ${slug} in this worktree: place copies an open task, it never opens one`);
  const problem = authorityProblem(start, slug, fields.authority);
  if (problem?.level === 'error') throw new Error(`task ${slug} cannot be placed: ${problem.msg}`);
  const files = ['TASK.md', 'JOURNAL.md'].filter(f => existsSync(join(here, f)));
  const differing = files.filter(f => existsSync(join(there, f))
    && readFileSync(join(there, f), 'utf8') !== readFileSync(join(here, f), 'utf8'));
  if (differing.length) {
    throw new Error(`the ledger holds a different ${differing.join(' and ')} for ${slug}: refused, never overwritten`
      + ' -- the user decides which record stands');
  }
  const missing = files.filter(f => !existsSync(join(there, f)));
  if (!missing.length) return `task ${slug} is already placed in the ledger`;
  mkdirSync(there, { recursive: true });
  for (const f of missing) writeFileSync(join(there, f), readFileSync(join(here, f), 'utf8'));
  return `placed ${slug} (${missing.join(', ')}) in ${there}`;
}
