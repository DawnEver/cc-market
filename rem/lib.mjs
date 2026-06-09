// lib.mjs — shared module for REM memory system
// Single source of truth for paths, frontmatter, index format, file collection, state.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { findProjectRoot as _findProjectRoot } from './shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState, appendEvent as _appendEvent } from './shared/state.mjs';

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

export function findAllScopes() {
  const scopes = [repoRoot];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = join(dir, entry.name);
          if (existsSync(join(sub, '.claude', 'memory'))) scopes.push(sub);
          walk(sub, depth + 1);
        }
      }
    } catch { /* permissions, etc. */ }
  }
  walk(repoRoot, 0);
  return scopes;
}

export const scopeRoot = findMemoryScope();
export const scopeMemoryDir = join(scopeRoot, '.claude', 'memory');
export const scopeRulesDir = join(scopeRoot, '.claude', 'rules');
export const scopeIndexFile = join(scopeRulesDir, 'MEMORY.md');

export const MAX_ENTRIES = 20;
export const STALE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

// ── Frontmatter ──

const FM_RE = /^---\n([\s\S]*?)\n---/;

export function parseFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { fm: '', body: content, fields: {} };
  const fm = m[1];
  const fields = {};
  for (const line of fm.split('\n')) {
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
  // Insert after the last frontmatter field before closing ---
  const fmEnd = content.indexOf('\n---');
  if (fmEnd < 0) return content;
  const before = content.slice(0, fmEnd);
  const after = content.slice(fmEnd);
  return before + `\n${key}: ${value}` + after;
}

export function getTier(content) {
  return getField(content, 'tier') || 'short';
}

export function setTier(content, tier) {
  return setField(content, 'tier', tier);
}

export function hasAllFields(content) {
  return /^created:/m.test(content) && /^accessed:/m.test(content) && /^tier:/m.test(content);
}

export function stampMissingFields(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (hasAllFields(content)) return false;
  const date = extractDateFromPath(filePath);
  let updated = content;
  if (!/^created:/m.test(updated)) updated = setField(updated, 'created', date);
  if (!/^accessed:/m.test(updated)) updated = setField(updated, 'accessed', date);
  if (!/^tier:/m.test(updated)) updated = setField(updated, 'tier', 'short');
  writeFileSync(filePath, updated, 'utf8');
  return true;
}

export function bumpAccessed(content, date) {
  return setField(content, 'accessed', date);
}

// ── Date helpers ──

export function todayISO(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === 'string') return date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

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
  // Match YYYY/MM/DD or YYYY-MM-DD in path
  const m = filePath.match(/(\d{4})[\/\\-](\d{2})[\/\\-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Fallback: warn so miscategorised files are visible rather than silently misdated
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

// ── Index ──

export const INDEX_HEADER = `# Memory Index

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)         — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)  — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run \`node scripts/touch-memory.js <path> --promote\` to upgrade short → long
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run \`node scripts/prune-memory.js --evict-stale\` (short-term eviction + long-term demotion check)
Compact:   run \`node scripts/compact.js --check\` when index grows large

Frontmatter:
  - created:  ISO date (parent folder date)
  - accessed: ISO date (bumped by touch-memory.js on reference)
  - tier:     long | short (default short, promoted via touch-memory.js --promote)
-->

`;

// Regex to match and parse an index entry line
const ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\s+(.+?)\]\(\.\.\/memory\/(.+?\.md)\)\s*—\s*`created:\s*(\d{4}-\d{2}-\d{2}),\s*accessed:\s*(\d{4}-\d{2}-\d{2})`/;

export function parseIndexEntry(line) {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  return {
    date: m[1],
    title: m[2],
    path: m[3],
    created: m[4],
    accessed: m[5],
    accessedDate: parseDate(m[5]),
    line,
  };
}

export function formatIndexEntry(entry) {
  return `- [${entry.date} ${entry.title}](../memory/${entry.path}) — \`created: ${entry.created}, accessed: ${entry.accessed}\``;
}

// Returns updated content on match, null if the memory path wasn't found in the index.
export function updateIndexAccessed(indexContent, memPath, newAccessed) {
  const escaped = memPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the separator generically — em-dash, en-dash, or plain dash with optional spaces
  const re = new RegExp(
    `(\\]\\(\.\.\\/memory\\/${escaped}\\)\\s+.{1,3}\\s+\`created:\\s*[^,]+),\\s*accessed:\\s*[^\`]+\``
  );
  if (!re.test(indexContent)) return null;
  return indexContent.replace(re, `$1, accessed: ${newAccessed}\``);
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

// ── State management (delegates to shared/state.mjs) ──

export function loadState() { return _loadState(stateFile); }
export function saveState(state) { return _saveState(stateFile, state); }
export function appendEvent(type, detail) { return _appendEvent(stateFile, type, detail); }
