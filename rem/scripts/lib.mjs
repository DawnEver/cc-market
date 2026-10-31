// lib.mjs — shared module for REM memory system
// Single source of truth for paths, frontmatter, entries, derived visibility and the derived index.

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { join, dirname, resolve, relative, basename, sep } from 'path';
import { findProjectRoot as _findProjectRoot, todayISO } from '../shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState } from '../shared/state.mjs';
import { writeIfChanged } from '../shared/atomic-write.mjs';

// One index line per entry: date, name, link, description.
export function formatIndexEntry(e) {
  return `- [${e.date} ${e.name}](../memory/${e.path})${e.description ? ` — ${e.description}` : ''}`;
}

// ── Paths ──

export function findProjectRoot(startDir) { return _findProjectRoot(startDir); }

export const repoRoot = findProjectRoot();
export const memoryDir = join(repoRoot, '.claude', 'memory');
export const rulesDir = join(repoRoot, '.claude', 'rules');
export const remRulesDir = join(rulesDir, 'rem');
export const indexFile = join(rulesDir, 'MEMORY.md');
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
export const scopeIndexFile = join(scopeRulesDir, 'MEMORY.md');

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
// The memory tree is the ONLY source of truth and no entry is ever deleted. There is
// no per-entry state: an entry's date is its path, its identity its file. Whether it
// is VISIBLE (to recall and the index) is derived from newer entries that name it;
// the file itself stays forever, reachable by provenance. Everything else is DERIVED
// from the tree by a pure function, so reading never writes and two sessions deriving
// the same tree write the same bytes.

// `merged_from:` as an inline comma list or a YAML block list. Each item is
// normalized to a path relative to its scope's `.claude/memory/`.
export function parseMergedFrom(content) {
  const m = content.match(FM_RE);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex(l => /^merged_from:/.test(l));
  if (at < 0) return [];
  const items = lines[at].replace(/^merged_from:\s*/, '').replace(/^\[|\]$/g, '').split(',');
  for (let i = at + 1; i < lines.length && /^\s+-\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s+-\s*/, ''));
  return items
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/'))
    .filter(s => s.endsWith('.md'))
    .map(s => s.replace(/^.*\.claude\/memory\//, ''));
}

// An entry lives at YYYY/MM/DD/<slug>.md under its scope's .claude/memory/.
export const DATED_RE = /^\d{4}\/\d{2}\/\d{2}\//;

// Every entry of a scope, newest first: { path, date, name, description, type, mergedFrom }.
export function listEntries(scopeRoot) {
  const memDir = join(scopeRoot, '.claude', 'memory');
  const entries = [];
  for (const abs of collectMemoryFiles(memDir)) {
    const path = relative(memDir, abs).replace(/\\/g, '/');
    if (path.startsWith('tasks/') || !DATED_RE.test(path)) continue;
    let content = '';
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const { fields } = parseFrontmatter(content);
    const typeMatch = content.match(/^metadata:\s*\r?\n(?:\s+.*\r?\n)*?\s+type:\s*(\w+)/m);
    entries.push({
      path,
      date: path.slice(0, 10).replace(/\//g, '-'),
      name: fields.name || basename(path, '.md'),
      description: (fields.description || '').replace(/^['"]|['"]$/g, ''),
      type: typeMatch ? typeMatch[1] : null,
      mergedFrom: parseMergedFrom(content),
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
  return entries;
}

// Entries a newer entry names in `merged_from`: their content has a home, so they
// leave recall and the index. The file stays. A self-reference never hides the entry.
export function hiddenEntries(entries) {
  const live = new Set(entries.map(e => e.path));
  const out = new Map();
  for (const e of entries) {
    for (const p of e.mergedFrom) {
      if (p !== e.path && live.has(p) && !out.has(p)) out.set(p, e.path);
    }
  }
  return out; // hidden path → the entry that holds it
}

// The injected index: entries a session must always see (user/feedback) plus the
// newest HOT_MAX. Recall reads the tree directly, so the index never gates recall.
export const HOT_MAX = 15;
export const INDEX_HEADER = `# Memory Index

<!-- GENERATED from .claude/memory/ by rem (rebuildIndex) — never hand-edit, never commit.
     Lists user/feedback entries and the newest ${HOT_MAX}; recall searches every entry.
     An entry retires when a live entry names it in \`merged_from:\`. -->
`;

export function renderIndex(scopeRoot, entries = listEntries(scopeRoot)) {
  const hidden = hiddenEntries(entries);
  const liveEntries = entries.filter(e => !hidden.has(e.path));
  const hot = liveEntries.filter((e, i) => i < HOT_MAX || e.type === 'user' || e.type === 'feedback');
  const lines = [INDEX_HEADER];
  const children = findChildScopes(scopeRoot);
  if (children.length) {
    lines.push('## Scoped\n');
    for (const child of children) {
      const rel = relative(scopeRoot, child).replace(/\\/g, '/');
      lines.push(`- ${rel} → see ${rel}/.claude/rules/MEMORY.md`);
    }
    lines.push('');
  }
  lines.push(`## Entries (${hot.length} of ${liveEntries.length})\n`);
  if (!hot.length) lines.push('_(no entries)_');
  for (const e of hot) lines.push(formatIndexEntry(e));
  return lines.join('\n') + '\n';
}

// Lock-free: the content is a pure function of the tree, so concurrent writers
// converge, and an unchanged index is never rewritten.
export function rebuildIndex(scopeRoot) {
  return writeIfChanged(join(scopeRoot, '.claude', 'rules', 'MEMORY.md'), renderIndex(scopeRoot));
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

// ── Scope split (relocate a cluster of entries into a child scope) ──
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

// Relocate `entryRelPaths` from `scopeRoot` into the child scope at `subdirRel`.
// The file moves into the child's memory tree; nothing else records the move.
// Both indexes rebuild (parent's Scoped section auto-picks-up the new child).
export function executeScopeSplit(scopeRoot, subdirRel, entryRelPaths) {
  const parentMem = join(scopeRoot, '.claude', 'memory');
  const childRoot = join(scopeRoot, subdirRel);
  const childMem = join(childRoot, '.claude', 'memory');
  let moved = 0;

  for (const rel of entryRelPaths) {
    const src = resolve(parentMem, rel);
    if (!isInsideDir(parentMem, src)) throw new Error(`path traversal denied (source): ${rel}`);
    const dest = resolve(childMem, rel);
    if (!isInsideDir(childMem, dest)) throw new Error(`path traversal denied (dest): ${rel}`);
    if (!existsSync(src)) continue;

    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    moved++;
  }

  rebuildIndex(childRoot);
  rebuildIndex(scopeRoot);
  return { moved, scope: subdirRel };
}

// ── State management (delegates to shared/state.mjs) ──

export function loadState() { return _loadState(stateFile); }
export function saveState(state, opts) { return _saveState(stateFile, state, opts); }

