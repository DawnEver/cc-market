// todo-lib.mjs — one backlog, never a second store.
//
//   - A task's open items are lines of its JOURNAL.md (tasks.mjs); closed by a later line.
//   - `.claude/rem.json` {"backlog": "issues"}: the repo backlog is the issue tracker, and
//     `todo` is a read-only view (task open items + a pointer to the tracker).
//   - Otherwise one file per item, `.claude/todo/<id>.md` (a unique name, status in the
//     frontmatter). A closed item is archived into memory like a task:
//     `.claude/memory/<date>/todo-<id>.md` (git mv; a plain rename outside git).
// Nothing here writes a checkbox, and nothing writes under .claude/memory/ except that move.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, appendFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { randomBytes } from 'crypto';
import { findProjectRoot, todayISO, SR_BLOCK_SPLIT_RE, SR_FINDING_HDR_RE, SR_STATUS_RE } from '../shared/lib.mjs';
import { spawnSync } from '../shared/spawn.mjs';
import { parseFrontmatter } from './lib.mjs';
import { listTasks } from './tasks.mjs';
import { evaluateDocs } from './doc-freshness.js';

export const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];
const rank = s => { const i = SEVERITIES.indexOf(String(s).toUpperCase()); return i < 0 ? SEVERITIES.length : i; };

export const todoDir = start => join(findProjectRoot(start), '.claude', 'todo');

// The repo's backlog home, from its committed .claude/rem.json: 'issues' or 'files'.
export function backlogMode(start) {
  try {
    const cfg = JSON.parse(readFileSync(join(findProjectRoot(start), '.claude', 'rem.json'), 'utf8'));
    return cfg.backlog === 'issues' ? 'issues' : 'files';
  } catch { return 'files'; }
}

const quote = s => JSON.stringify(String(s));

export function readItem(file) {
  const text = readFileSync(file, 'utf8');
  const { fields, body } = parseFrontmatter(text);
  const unq = v => (v || '').replace(/^"|"$/g, '');
  return {
    id: fields.name, summary: unq(fields.description), status: fields.status || 'open',
    severity: fields.severity || 'MEDIUM', module: fields.module || 'general',
    created: fields.created || '', file: fields.file || '', from: fields.from || '',
    body: body.trim(), path: file,
  };
}

export function listItems(start) {
  const dir = todoDir(start);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => readItem(join(dir, f)));
}

// A new item: a NEW file with a unique name (no counter, so concurrent adds never collide).
export function addItem(start, summary, { severity = 'MEDIUM', module = 'general', file = '', from = '', detail = '', date = todayISO() } = {}) {
  if (backlogMode(start) === 'issues') throw new Error('this repo\'s backlog is the issue tracker (.claude/rem.json backlog: issues) — file an issue there');
  if (!summary || /[\r\n]/.test(summary)) throw new Error('a todo item needs a one-line summary');
  const sev = String(severity).toUpperCase();
  if (!SEVERITIES.includes(sev)) throw new Error(`--severity must be one of ${SEVERITIES.join('|')}`);
  const id = `T${date.replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
  const target = join(todoDir(start), `${id}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, [
    '---', `name: ${id}`, `description: ${quote(summary)}`, 'kind: todo', 'status: open',
    `severity: ${sev}`, `module: ${module}`, `created: ${date}`,
    ...(file ? [`file: ${file}`] : []), ...(from ? [`from: ${from}`] : []),
    '---', '', detail || summary, '',
  ].join('\n'), { flag: 'wx' });
  return { id, path: target };
}

// Close = record how, then archive into memory (git mv; a rename outside git). Nothing is deleted.
export function closeItem(start, id, how, { date = todayISO() } = {}) {
  if (/^O\d+$/.test(id)) throw new Error(`${id} is a task's open item — close it in its journal: task.js close-item ${id} "<how>" --task <slug>`);
  const src = join(todoDir(start), `${id}.md`);
  if (!/^T\d{8}-[0-9a-f]{6}$/.test(id) || !existsSync(src)) throw new Error(`no open todo item ${id}`);
  const text = readFileSync(src, 'utf8');
  writeFileSync(src, text.replace(/^status: .*$/m, `status: closed\nclosed: ${date}`), 'utf8');
  appendFileSync(src, `\nClosed ${date}: ${how || 'done'}\n`, 'utf8');
  const root = findProjectRoot(start);
  const [y, m, d] = date.split('-');
  const dest = join(root, '.claude', 'memory', y, m, d, `todo-${id}.md`);
  mkdirSync(dirname(dest), { recursive: true });
  const moved = spawnSync('git', ['mv', src, dest], { cwd: root, encoding: 'utf8' });
  if (moved.status !== 0) renameSync(src, dest);
  return dest;
}

// ── Legacy checkbox files (manual.md, sharp-review.md) ──
// Each OPEN item becomes its own item file citing `from: memory/<path>#<id>`; closed items
// stay history. The legacy file is never touched: it is memory, and memory is immutable.

const CHECKBOX_RE = /^-\s+\[([ x])\]\s+(\S+)\s+\[(\w+)\]\s+(.+?)\s+\((\d{4}-?\d{2}-?\d{2}|undefined)\)/;

export function parseLegacyItems(content) {
  const out = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(CHECKBOX_RE);
    if (!m) return;
    const module = lines[i + 1]?.match(/^\s+module:\s*(\S+)/)?.[1] || 'general';
    out.push({ id: m[2], open: m[1] === ' ', severity: m[3], summary: m[4], module, file: '' });
  });
  for (const block of content.split(SR_BLOCK_SPLIT_RE)) {
    const hdr = block.match(SR_FINDING_HDR_RE);
    if (!hdr) continue;
    const status = (block.match(SR_STATUS_RE)?.[1] || 'OPEN').toUpperCase();
    out.push({ id: hdr[1], open: status === 'OPEN', severity: hdr[2], summary: hdr[4].trim(), module: 'review', file: hdr[3].trim(), detail: block.trim() });
  }
  return out;
}

export function adoptLegacy(start, relFiles) {
  const root = findProjectRoot(start);
  const adopted = new Set(listItems(start).map(i => i.from).filter(Boolean));
  const made = [];
  for (const rel of relFiles) {
    const abs = join(root, rel);
    const memRel = relative(join(root, '.claude'), abs).replace(/\\/g, '/');
    for (const item of parseLegacyItems(readFileSync(abs, 'utf8'))) {
      const from = `${memRel}#${item.id}`;
      if (!item.open || adopted.has(from)) continue;
      const severity = SEVERITIES.includes(item.severity.toUpperCase()) ? item.severity : 'MEDIUM';
      made.push(addItem(start, item.summary, { severity, module: item.module, file: item.file, from, detail: item.detail }).id);
      adopted.add(from);
    }
  }
  return made;
}

// ── The report: read-only ──

function staleDocRows(root, today) {
  try {
    return evaluateDocs(root, root, today, { persist: false }).map(d => ({
      id: `DOC-${d.relPath.replace(/\\/g, '/').replace(/\.md$/, '')}`,
      summary: `Refresh ${d.relPath} — ${d.commits === Infinity ? '∞' : d.commits} commits drift`,
    }));
  } catch { return []; }
}

export function formatReport(start, { moduleFilter = null, sortBySeverity = false, today = todayISO() } = {}) {
  const root = findProjectRoot(start);
  const lines = [];
  const taskItems = listTasks(root).filter(t => t.status === 'open')
    .flatMap(t => t.openItems.map(i => `  ${t.slug} O${i.n}: ${i.text}`));
  lines.push('[todo] Task open items (close with task.js close-item)');
  lines.push(...(taskItems.length ? taskItems : ['  (none)']));

  let backlogCount = 0;
  if (backlogMode(root) === 'issues') {
    lines.push('[todo] Backlog: the issue tracker (.claude/rem.json backlog: issues) — file and close items there');
  } else {
    let open = listItems(root).filter(i => i.status === 'open');
    if (moduleFilter) open = open.filter(i => i.module === moduleFilter);
    backlogCount = open.length;
    lines.push('[todo] Backlog (.claude/todo/)');
    if (!open.length) lines.push('  (none)');
    const modules = [...new Set(open.map(i => i.module))].sort();
    for (const mod of modules) {
      let rows = open.filter(i => i.module === mod);
      if (sortBySeverity) rows = [...rows].sort((a, b) => rank(a.severity) - rank(b.severity));
      lines.push(`  ## ${mod}`);
      for (const i of rows) lines.push(`  - ${i.id} [${i.severity}] ${i.summary} (${i.created})${i.file ? ` — ${i.file}` : ''}`);
    }
  }
  const docs = staleDocRows(root, today);
  if (docs.length) {
    lines.push('[todo] Stale docs (refresh via /refresh-docs)');
    for (const d of docs) lines.push(`  - ${d.id} ${d.summary}`);
  }
  lines.push(`[todo] ${taskItems.length} task item(s), ${backlogCount} backlog item(s), ${docs.length} stale doc(s)`);
  return lines.join('\n');
}
