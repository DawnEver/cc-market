// lib.mjs — shared module for REM memory system
// Single source of truth for paths, frontmatter, entries, derived visibility and the derived index.

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join, dirname, resolve, relative, basename, sep } from 'path';
import { findProjectRoot as _findProjectRoot, todayISO } from '../shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState } from '../shared/state.mjs';
import { writeIfChanged } from '../shared/atomic-write.mjs';

// ── Paths ──

export function findProjectRoot(startDir) { return _findProjectRoot(startDir); }

export const repoRoot = findProjectRoot();
export const memoryDir = join(repoRoot, '.claude', 'memory');
export const rulesDir = join(repoRoot, '.claude', 'rules');
export const remRulesDir = join(rulesDir, 'rem');
export const stateFile = join(repoRoot, '.claude', '.rem-state.json');

// ── Scope-aware paths ──

export function findMemoryScope() {
  let dir = process.cwd();
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  while (dir.startsWith(root)) {
    if (existsSync(join(dir, '.claude', 'memory'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return root;
}

// Convert a simple glob (supporting `*` and `?`) to an anchored RegExp.
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$');
}

// True if a directory should be skipped during scope discovery. `name` is the
// directory's basename, `rel` its path relative to the scan root. Patterns without
// a `/` match the basename; patterns with a `/` match the relative path. Both forms
// support `*` and `?` globs.
export function isScopeIgnored(name, rel, patterns) {
  if (!patterns || !patterns.length) return false;
  const relNorm = rel.split(sep).join('/');
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return p.includes('/') ? re.test(relNorm) : re.test(name);
  });
}

// Resolve ignore patterns: explicit arg wins, else read from .rem-state.json.
function resolveIgnore(ignore) {
  if (ignore) return ignore;
  try { return loadState().scopes?.ignore || []; } catch { return []; }
}

export function findAllScopes(base, ignore) {
  const root = base || repoRoot;
  const patterns = resolveIgnore(ignore);
  const scopes = [root];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = join(dir, entry.name);
          if (isScopeIgnored(entry.name, relative(root, sub), patterns)) continue;
          if (existsSync(join(sub, '.claude', 'memory'))) scopes.push(sub);
          walk(sub, depth + 1);
        }
      }
    } catch { /* permissions, etc. */ }
  }
  walk(root, 0);
  return scopes;
}

export function findChildScopes(scopeRoot, ignore) {
  const patterns = resolveIgnore(ignore);
  const children = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = join(dir, entry.name);
          if (isScopeIgnored(entry.name, relative(scopeRoot, sub), patterns)) continue;
          if (existsSync(join(sub, '.claude', 'memory'))) children.push(sub);
          walk(sub, depth + 1);
        }
      }
    } catch { /* permissions */ }
  }
  walk(scopeRoot, 0);
  return children;
}

export const scopeRoot = findMemoryScope();
export const scopeMemoryDir = join(scopeRoot, '.claude', 'memory');
export const scopeRulesDir = join(scopeRoot, '.claude', 'rules');

export const CRYSTALLIZE_ADVISORY = 400; // live entries past which /rem recommends crystallize
export const DAY_MS = 24 * 60 * 60 * 1000;

// ── Frontmatter ──

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { fm: '', body: content, fields: {} };
  const fm = m[1];
  const fields = {};
  for (const line of fm.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fm, body: content.slice(m[0].length), fields };
}

export function getField(content, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

export function setField(content, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, `${key}: ${value}`);
  }
  const fmEnd = content.search(/\r?\n---/);
  if (fmEnd < 0) return content;
  const before = content.slice(0, fmEnd);
  const after = content.slice(fmEnd);
  return before + `\n${key}: ${value}` + after;
}

export function removeField(content, key) {
  const re = new RegExp(`^${key}:.*\n?`, 'm');
  return content.replace(re, '');
}

// ── Date helpers ──

export { todayISO };

export function parseDate(s) {
  return new Date(s).getTime();
}

export function dayPrecision(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function dateToPath(date) {
  const [y, m, d] = todayISO(date).split('-');
  return `${y}/${m}/${d}`;
}

export function extractDateFromPath(filePath) {
  const m = filePath.match(/(\d{4})[\/\\](\d{2})[\/\\](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  console.warn(`[warn] extractDateFromPath: no date segment in path, falling back to mtime/today: ${filePath}`);
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch { return todayISO(); }
}

// ── Path security ──

export function resolveMemoryPath(relPath) {
  return resolve(memoryDir, relPath);
}

export function isInsideMemoryDir(absPath) {
  const resolved = resolve(absPath);
  const memResolved = resolve(memoryDir);
  return resolved.startsWith(memResolved + '\\') || resolved.startsWith(memResolved + '/') || resolved === memResolved;
}

// ── Entries, visibility, index ──
//
// The memory tree is the ONLY source of truth and no entry is ever deleted or edited.
// There is no per-entry state: an entry's date is its path, its identity its file. All
// provenance is written by the NEWER entry, in its frontmatter:
//   merged_from: <paths>  — their content now lives here       → they are hidden
//   supersedes:  <paths>  — this restates the current truth    → they are hidden
//   corrects:    <paths>  — this corrects part of them         → they stay visible, flagged
// Visibility is DERIVED from those fields; a hidden file stays forever, reachable by
// provenance. Everything here is a pure function of the tree: reading never writes, and
// two machines deriving the same tree produce the same bytes.

export const PROVENANCE_FIELDS = ['merged_from', 'supersedes', 'corrects'];

// A provenance field as an inline comma list or a YAML block list. Each item is
// normalized to a path relative to its scope's `.claude/memory/`.
export function parseRefs(content, key) {
  return parseList(content, key)
    .filter(s => s.endsWith('.md') || /^\d{4}\/\d{2}\/\d{2}\/task-[^/]+$/.test(s))
    .map(s => s.replace(/^.*\.claude\/memory\//, ''));
}

// A frontmatter list field (inline comma list or YAML block list), items unquoted, POSIX.
export function parseList(content, key) {
  const m = content.match(FM_RE);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex(l => l.startsWith(`${key}:`));
  if (at < 0) return [];
  const items = lines[at].slice(key.length + 1).trim().replace(/^\[|\]$/g, '').split(',');
  for (let i = at + 1; i < lines.length && /^\s+-\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s+-\s*/, ''));
  return items.map(s => s.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/')).filter(Boolean);
}

// Frontmatter lines for the provenance a new entry writes, in PROVENANCE_FIELDS order.
export function formatRefs(refs) {
  return PROVENANCE_FIELDS
    .filter(k => refs[k]?.length)
    .map(k => `${k}:\n${refs[k].map(p => `  - ${p}`).join('\n')}\n`)
    .join('');
}

// An entry lives at YYYY/MM/DD/<name> under its scope's .claude/memory/: <name> is a
// file (an entry, kind: entry) or a directory holding TASK.md (an archived task, kind: task).
export const DATED_RE = /^\d{4}\/\d{2}\/\d{2}\//;
const ENTRY_FILE_RE = /^\d{4}\/\d{2}\/\d{2}\/[^/]+\.md$/;
const TASK_DIR_RE = /^(\d{4}\/\d{2}\/\d{2}\/[^/]+)\/TASK\.md$/;

// Byte order, never locale order: the same tree sorts the same on every machine.
export const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Every entry of a scope, newest first, then by path. ONE frontmatter for both kinds:
// { path, date, kind, name, description, type, task, created, from, mergedFrom, supersedes, corrects }.
// Absent fields are derived, never duplicated: kind defaults to entry, created to the
// path date, scope to the directory holding .claude/memory/.
export function listEntries(scopeRoot) {
  const memDir = join(scopeRoot, '.claude', 'memory');
  const entries = [];
  for (const abs of collectMemoryFiles(memDir)) {
    const rel = relative(memDir, abs).replace(/\\/g, '/');
    const taskDir = rel.match(TASK_DIR_RE)?.[1];
    if (!taskDir && !ENTRY_FILE_RE.test(rel)) continue;
    const path = taskDir || rel;
    let content = '';
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const { fields } = parseFrontmatter(content);
    const typeMatch = content.match(/^metadata:\s*\r?\n(?:\s+.*\r?\n)*?\s+type:\s*(\w+)/m);
    const date = path.slice(0, 10).replace(/\//g, '-');
    entries.push({
      path,
      date,
      kind: taskDir ? 'task' : (fields.kind || 'entry'),
      name: fields.name || basename(path, '.md'),
      description: (fields.description || '').replace(/^['"]|['"]$/g, ''),
      type: typeMatch ? typeMatch[1] : null,
      task: fields.task || null,
      created: fields.created || date,
      from: parseList(content, 'from'),
      mergedFrom: parseRefs(content, 'merged_from'),
      supersedes: parseRefs(content, 'supersedes'),
      corrects: parseRefs(content, 'corrects'),
    });
  }
  entries.sort((a, b) => byteOrder(b.date, a.date) || byteOrder(a.path, b.path));
  return entries;
}

// Entries a newer entry names in `merged_from` or `supersedes` (their content has a
// home), and archived tasks and todo items (records, not knowledge): they leave recall and
// the index. The files stay, reachable by provenance. A self-reference never hides.
export function hiddenEntries(entries) {
  const live = new Set(entries.map(e => e.path));
  const out = new Map();
  for (const e of entries) if (e.kind === 'task' || e.kind === 'todo') out.set(e.path, `archived ${e.kind}`);
  for (const e of entries) {
    for (const p of [...e.mergedFrom, ...e.supersedes]) {
      if (p !== e.path && live.has(p) && !out.has(p)) out.set(p, e.path);
    }
  }
  return out; // hidden path → the entry that holds it
}

// Entries a newer entry `corrects`: still visible, flagged with their corrections.
export function correctionsOf(entries) {
  const live = new Set(entries.map(e => e.path));
  const out = new Map();
  for (const e of entries) {
    for (const p of e.corrects) {
      if (p === e.path || !live.has(p)) continue;
      if (!out.has(p)) out.set(p, []);
      out.get(p).push(e.path);
    }
  }
  for (const list of out.values()) list.sort(byteOrder);
  return out; // corrected path → the entries that correct it
}

// Visible entries of a scope, each carrying `correctedBy` (possibly empty).
export function visibleEntries(entries) {
  const hidden = hiddenEntries(entries);
  const corrections = correctionsOf(entries);
  return entries.filter(e => !hidden.has(e.path))
    .map(e => ({ ...e, correctedBy: corrections.get(e.path) || [] }));
}

// The derived index: one file per scope, OUTSIDE .claude/rules/ (nothing generated
// loads as a rule) and outside .claude/memory/ (it is not an entry). Read on demand.
export function indexFilePath(scopeRoot) {
  return join(scopeRoot, '.claude', 'memory-index.md');
}

export const INDEX_HEADER = `# Memory Index

<!-- DERIVED from .claude/memory/ by rem — never hand-edit. Every visible entry, newest
     first. An entry named by a newer entry's merged_from/supersedes is hidden (its file
     stays); one named by corrects is flagged with its correction. -->
`;

// One index line per visible entry: date, name, link, description, corrections.
export function formatIndexEntry(e) {
  const fix = e.correctedBy?.length ? ` (corrected by ${e.correctedBy.map(p => `memory/${p}`).join(', ')})` : '';
  return `- [${e.date} ${e.name}](memory/${e.path})${e.description ? ` — ${e.description}` : ''}${fix}`;
}

export function renderIndex(scopeRoot, entries = listEntries(scopeRoot)) {
  const visible = visibleEntries(entries);
  const lines = [INDEX_HEADER];
  const children = findChildScopes(scopeRoot)
    .map(child => relative(scopeRoot, child).replace(/\\/g, '/'))
    .sort(byteOrder);
  if (children.length) {
    lines.push('## Scoped\n');
    for (const rel of children) lines.push(`- ${rel} → see ${rel}/.claude/memory-index.md`);
    lines.push('');
  }
  lines.push(`## Entries (${visible.length} visible of ${entries.length})\n`);
  if (!visible.length) lines.push('_(no entries)_');
  for (const e of visible) lines.push(formatIndexEntry(e));
  return lines.join('\n') + '\n';
}

// Lock-free: the content is a pure function of the tree, so concurrent writers
// converge, and an unchanged index is never rewritten.
export function rebuildIndex(scopeRoot) {
  return writeIfChanged(indexFilePath(scopeRoot), renderIndex(scopeRoot));
}

// Write a NEW file, exclusively (O_EXCL): true when this call created it, false when the
// name already exists. Check and create are one syscall, so two writers racing for one
// name never both succeed and never interleave bytes. Memory is written only this way.
export function writeOnce(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  try { writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); return true; }
  catch (err) { if (err.code === 'EEXIST') return false; throw err; }
}

// ── File collection ──

// Every file under dir (dot-entries skipped).
export function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}

export function collectMemoryFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectMemoryFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

// ── Scope split (make a child scope for a cluster; nothing moves) ──
//
// Generic and structure-agnostic: a candidate child scope must correspond to a real
// subdirectory that the clustered entries reference. No assumption about repo layout
// (monorepo, flat, src/, packages/*) — the algorithm degrades to silence wherever no
// internal module boundary exists. All paths normalized to POSIX for cross-platform
// determinism (identical index across macOS, Linux, Windows).

export const SPLIT_DEFAULTS = {
  minOwnEntries: 30,        // size-pressure gate: own (non-child) indexed entries
  minClusterEntries: 5,     // a subdir must own at least this many entries to split
  maxBytes: 500 * 1024,     // alternate size-pressure gate: total own memory bytes
};

// Resolve thresholds: explicit opts win, else `.rem-state.json` scopes.split, else defaults.
export function resolveSplitConfig(opts) {
  let fromState = {};
  try { fromState = loadState().scopes?.split || {}; } catch { /* defaults */ }
  return { ...SPLIT_DEFAULTS, ...fromState, ...(opts || {}) };
}

// Liberal extraction of path-like tokens from memory content. Existence checks
// downstream filter out non-paths, so over-matching here is harmless.
const REF_PATH_RE = /(?<![\w.\/])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
export function extractReferencedPaths(content) {
  if (!content) return [];
  const out = [];
  let m;
  while ((m = REF_PATH_RE.exec(content)) !== null) {
    const tok = m[1];
    if (/^[a-z]+:/i.test(tok) || tok.includes('://')) continue; // urls/schemes
    out.push(tok);
  }
  return out;
}

// The directory portion of a path token: drop the basename only if it looks like a file.
function dirSegments(p) {
  const segs = p.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last && last.includes('.')) segs.pop();
  return segs;
}

// Longest common leading directory shared by every path (POSIX). '' if none.
export function longestCommonDirPrefix(paths) {
  if (!paths || !paths.length) return '';
  const segLists = paths.map(dirSegments);
  const first = segLists[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (!segLists.every((s) => s[i] === first[i])) break;
  }
  return first.slice(0, i).join('/');
}

// True if `absPath` is `parent` or a descendant of it (rejects traversal/siblings).
export function isInsideDir(parent, absPath) {
  const p = resolve(parent);
  const a = resolve(absPath);
  return a === p || a.startsWith(p + sep);
}

// Infer the child scope a single entry belongs to: the deepest existing directory,
// strictly below `scopeRoot`, shared by all paths the entry references. null when
// the owner is absent, ambiguous (references span unrelated modules), or unreferenced.
export function inferEntrySubdir(scopeRoot, content) {
  const refs = extractReferencedPaths(content);
  if (!refs.length) return null;
  let prefix = longestCommonDirPrefix(refs);
  while (prefix) {
    const abs = join(scopeRoot, prefix);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) return prefix;
    } catch { /* fall through to trim */ }
    const idx = prefix.lastIndexOf('/');
    prefix = idx >= 0 ? prefix.slice(0, idx) : '';
  }
  return null;
}

// Group entry rel-paths (POSIX, relative to the scope memory dir) by inferred subdir.
// Entries with no clear owner are omitted. Returns Map<subdir, relPath[]>.
export function clusterBySubdir(scopeRoot, entryRelPaths) {
  const memDir = join(scopeRoot, '.claude', 'memory');
  const clusters = new Map();
  for (const rel of entryRelPaths) {
    const abs = join(memDir, rel);
    let content = '';
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const subdir = inferEntrySubdir(scopeRoot, content);
    if (!subdir) continue;
    if (!clusters.has(subdir)) clusters.set(subdir, []);
    clusters.get(subdir).push(rel);
  }
  return clusters;
}

// Propose child-scope splits for `scopeRoot`. Returns [] unless size pressure is met
// (own entry count ≥ minOwnEntries OR total own bytes > maxBytes) AND a real subdir
// owns ≥ minClusterEntries entries, is not already a scope, and is not ignored.
export function proposeScopeSplits(scopeRoot, opts) {
  const cfg = resolveSplitConfig(opts);
  const memDir = join(scopeRoot, '.claude', 'memory');
  const own = [];
  let totalBytes = 0;
  for (const { path: rel } of listEntries(scopeRoot)) {
    own.push(rel);
    try { totalBytes += statSync(join(memDir, rel)).size; } catch { /* gone */ }
  }

  const sizePressure = own.length >= cfg.minOwnEntries || totalBytes > cfg.maxBytes;
  if (!sizePressure) return [];

  const patterns = resolveIgnore();
  const clusters = clusterBySubdir(scopeRoot, own);
  const candidates = [];
  for (const [subdir, entries] of clusters) {
    if (entries.length < cfg.minClusterEntries) continue;
    if (existsSync(join(scopeRoot, subdir, '.claude', 'memory'))) continue; // already a scope
    const base = subdir.split('/').pop();
    if (isScopeIgnored(base, subdir, patterns)) continue;
    candidates.push({
      scope: subdir,
      entryCount: entries.length,
      entries,
      rationale: `${entries.length} entries reference ${subdir}/**; subdir exists and is not yet a scope`,
    });
  }
  candidates.sort((a, b) => b.entryCount - a.entryCount);
  return candidates;
}

// Make `subdirRel` a child scope. NOTHING moves: an entry's path is part of its identity
// (citations name it), so existing entries stay in the parent, which recall reads from
// inside the child too. New entries written under the child land in its own tree.
export function executeScopeSplit(scopeRoot, subdirRel) {
  const childRoot = resolve(scopeRoot, subdirRel);
  if (childRoot === resolve(scopeRoot) || !isInsideDir(scopeRoot, childRoot)) throw new Error(`not a subdirectory of the scope: ${subdirRel}`);
  mkdirSync(join(childRoot, '.claude', 'memory'), { recursive: true });
  rebuildIndex(childRoot);
  rebuildIndex(scopeRoot);
  return { scope: subdirRel.replace(/\\/g, '/') };
}

// ── State management (delegates to shared/state.mjs) ──

export function loadState() { return _loadState(stateFile); }
export function saveState(state, opts) { return _saveState(stateFile, state, opts); }

