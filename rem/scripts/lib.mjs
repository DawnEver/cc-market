// lib.mjs — shared module for REM memory system
// Single source of truth for paths, frontmatter, index format, file collection, state.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import { join, dirname, resolve, relative, sep } from 'path';
import { findProjectRoot as _findProjectRoot, todayISO } from '../shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState, appendEvent as _appendEvent } from '../shared/state.mjs';

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

export const MAX_ENTRIES = 20;
export const STALE_DAYS = 90;
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

// ── Memory state (_meta.json per date directory) ──

function metaPath(scopeRoot, dateStr) {
  const [y, m, d] = dateStr.split('-');
  return join(scopeRoot, '.claude', 'memory', y, m, d, '_meta.json');
}

export function loadMemoryState(scopeRoot) {
  const memDir = join(scopeRoot, '.claude', 'memory');
  const map = new Map();
  if (!existsSync(memDir)) return map;

  function walk(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'tasks') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (entry.name === '_meta.json') {
          try {
            const data = JSON.parse(readFileSync(full, 'utf8'));
            const dateDir = relative(memDir, dirname(full)).replace(/\\/g, '/');
            for (const [slug, meta] of Object.entries(data)) {
              map.set(`${dateDir}/${slug}`, meta);
            }
          } catch { /* corrupt _meta.json — skip */ }
        }
      }
    } catch { /* permissions */ }
  }
  walk(memDir);

  // Backfill: .md files on disk but missing from _meta.json get defaults
  const allMd = collectMemoryFiles(memDir);
  for (const absPath of allMd) {
    const relPath = relative(memDir, absPath).replace(/\\/g, '/');
    if (relPath.startsWith('tasks/')) continue;
    if (!map.has(relPath)) {
      const date = extractDateFromPath(absPath);
      map.set(relPath, { accessed: date, count: 1, tier: 'short' });
    }
  }

  return map;
}

export function saveMemoryMeta(scopeRoot, relPath, patch) {
  const date = extractDateFromPath(relPath);
  const file = metaPath(scopeRoot, date);
  const slug = relPath.split('/').pop();

  let data = {};
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* start fresh */ }
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }

  data[slug] = { ...(data[slug] || {}), ...patch };
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

export function getMemoryMeta(scopeRoot, relPath) {
  const state = loadMemoryState(scopeRoot);
  if (state.has(relPath)) return state.get(relPath);
  const date = extractDateFromPath(relPath);
  return { accessed: date, count: 1, tier: 'short' };
}

export function bumpAccessed(scopeRoot, relPath, date) {
  const cur = getMemoryMeta(scopeRoot, relPath);
  const count = cur.accessed !== date ? cur.count + 1 : cur.count;
  saveMemoryMeta(scopeRoot, relPath, { accessed: date, count });
}

export function dropFromIndex(scopeRoot, relPath, reason) {
  saveMemoryMeta(scopeRoot, relPath, { dropped: reason });
}

// ── Index ──

export const INDEX_HEADER = `# Memory Index

<!-- GENERATED — do not hand-edit. Rebuilt by rebuildIndex() on each session start,
     touch, prune, and stamp. Device-local (gitignored). -->

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)          — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)   — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run \`node scripts/touch-memory.js <path> --promote\` to upgrade short → long,
           or automatic when access_count >= 3 (rem-prep.js --promote)
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run \`node scripts/prune-memory.js --evict-stale\` (short-term eviction + long-term demotion check)
Compact:   run \`node scripts/compact.js --check\` when index grows large

Path format:  ../memory/YYYY/MM/DD/slug.md — nested per-day directories (required).

Frontmatter (content fields only):
  - name:        short kebab-case slug (required)
  - description: one-line summary (required)
  - metadata.type: user | feedback | project | reference (required)

Volatile metadata (accessed, count, tier, dropped) lives in gitignored
_memory/YYYY/MM/DD/_meta.json per date directory — never in frontmatter.
-->

`;

function buildIndexEntries(scopeRoot, state) {
  const memDir = join(scopeRoot, '.claude', 'memory');
  const entries = [];

  for (const [relPath, meta] of state) {
    if (meta.dropped) continue;
    if (relPath.startsWith('tasks/')) continue;

    const absPath = join(memDir, relPath);
    let title = relPath.split('/').pop().replace('.md', '');
    let created = extractDateFromPath(relPath);
    let description = '';

    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, 'utf8');
        const { fields } = parseFrontmatter(content);
        if (fields.name) title = fields.name;
        if (fields.description) description = fields.description;
      } catch { /* use defaults */ }
    }

    entries.push({
      date: meta.accessed,
      title,
      path: relPath,
      created,
      accessed: meta.accessed,
      accessedDate: parseDate(meta.accessed),
      createdDate: parseDate(created),
    });
  }

  // Also include .md files on disk not yet in state (first-time stamp)
  const allMd = collectMemoryFiles(memDir);
  const indexed = new Set(state.keys());
  for (const absPath of allMd) {
    const relPath = relative(memDir, absPath).replace(/\\/g, '/');
    if (relPath.startsWith('tasks/')) continue;
    if (indexed.has(relPath)) continue;

    let title = relPath.split('/').pop().replace('.md', '');
    const created = extractDateFromPath(absPath);
    try {
      const content = readFileSync(absPath, 'utf8');
      const { fields } = parseFrontmatter(content);
      if (fields.name) title = fields.name;
    } catch { /* use defaults */ }

    entries.push({
      date: created,
      title,
      path: relPath,
      created,
      accessed: created,
      accessedDate: parseDate(created),
      createdDate: parseDate(created),
    });
  }

  // Sort: accessed desc, tiebreak created desc
  entries.sort((a, b) => b.accessedDate - a.accessedDate || b.createdDate - a.createdDate);
  return entries;
}

export function rebuildIndex(scopeRoot) {
  const rulesDir = join(scopeRoot, '.claude', 'rules');
  const indexFile = join(rulesDir, 'MEMORY.md');
  const state = loadMemoryState(scopeRoot);

  const entries = buildIndexEntries(scopeRoot, state);

  // Build Scoped section from child scopes
  const children = findChildScopes(scopeRoot);
  let scopedSection = '';
  if (children.length > 0) {
    scopedSection = '\n## Scoped\n\n';
    for (const child of children) {
      const childRel = relative(scopeRoot, child).replace(/\\/g, '/') || child;
      scopedSection += `- ${childRel} → see ${childRel}/.claude/rules/MEMORY.md\n`;
    }
  }

  // Build index
  const lines = [INDEX_HEADER.trimEnd()];
  if (scopedSection) lines.push(scopedSection);
  lines.push('\n## Entries');
  if (entries.length === 0) {
    lines.push('\n_(no entries)_');
  } else {
    for (const e of entries) {
      lines.push(formatIndexEntry(e));
    }
  }

  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(indexFile, lines.join('\n') + '\n', 'utf8');
}

// Regex to match and parse an index entry line
const ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\s+(.+?)\]\(\.\.\/memory\/(.+?\.md)\)\s*—\s*`created:\s*(\d{4}-\d{2}-\d{2}),\s*accessed:\s*(\d{4}-\d{2}-\d{2})`/;

export function normalizeMemoryPath(relPath) {
  return relPath.replace(/^(\d{4})-(\d{2})-(\d{2})\//, '$1/$2/$3/');
}

export function parseIndexEntry(line) {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  return {
    date: m[1],
    title: m[2],
    path: normalizeMemoryPath(m[3]),
    created: m[4],
    accessed: m[5],
    accessedDate: parseDate(m[5]),
    line,
  };
}

export function formatIndexEntry(entry) {
  return `- [${entry.date} ${entry.title}](../memory/${entry.path}) — \`created: ${entry.created}, accessed: ${entry.accessed}\``;
}

export function parseIndex(content) {
  const lines = content.split('\n');
  const header = [];
  const entries = [];
  for (const line of lines) {
    const e = parseIndexEntry(line);
    if (e) {
      entries.push(e);
    } else if (entries.length === 0) {
      header.push(line);
    }
  }
  return { header, entries };
}

// ── File collection ──

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
// determinism (identical _meta.json / index across macOS, Linux, Windows).

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
  const state = loadMemoryState(scopeRoot);

  // Own (non-dropped, non-task) indexed entries.
  const own = [];
  let totalBytes = 0;
  for (const [rel, meta] of state) {
    if (meta.dropped || rel.startsWith('tasks/')) continue;
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
// Move + tombstone: file physically moves into the child's memory tree; the parent's
// _meta.json records `dropped: 'migrated→<subdir>'`; tier/access metadata carries over.
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

    const meta = getMemoryMeta(scopeRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);

    dropFromIndex(scopeRoot, rel, `migrated→${subdirRel}`);
    saveMemoryMeta(childRoot, rel, {
      accessed: meta.accessed,
      count: meta.count,
      tier: meta.tier,
    });
    moved++;
  }

  rebuildIndex(childRoot);
  rebuildIndex(scopeRoot);
  appendEvent('split', { to: subdirRel, count: moved });
  return { moved, scope: subdirRel };
}

// ── State management (delegates to shared/state.mjs) ──

export function loadState() { return _loadState(stateFile); }
export function saveState(state) { return _saveState(stateFile, state); }
export function appendEvent(type, detail) { return _appendEvent(stateFile, type, detail); }
