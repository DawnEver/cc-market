// shared/lib.mjs — pure utilities shared across cc-market plugins
// No plugin-specific imports; safe to import from any plugin.
// No project-specific data — only reusable functions.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── findProjectRoot: walk up to nearest .git ──

export function findProjectRoot(startDir) {
  let dir = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ── isMain: reliable is-main guard ──

export function isMain(importMeta) {
  if (!importMeta || !process.argv[1]) return false;
  return fileURLToPath(importMeta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
}

// ── readStdinJSON: parse stdin as JSON with BOM handling ──

export function readStdinJSON() {
  if (process.stdin.isTTY) return {};
  try {
    let raw = readFileSync(0, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── readTranscriptTail: read last N lines of a JSONL transcript ──

export function readTranscriptTail(transcriptPath, maxLines = 40) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── parseFrontmatter: limited YAML frontmatter parser ──
//
// Parses the constrained YAML subset this repo actually uses in memory-file
// frontmatter — NOT general YAML (no anchors, multi-line scalars, or flow maps).
// Supports: `key: value`, one level of nested `key:` maps, inline arrays
// `[a, b]`, and block lists (`  - item`). Returns the parsed object, or null if
// there is no `---`-delimited frontmatter block. Deliberately dependency-free.

function coerceScalar(raw) {
  const s = raw.trim();
  const inline = s.match(/^\[(.*)\]$/);
  if (inline) {
    return inline[1].split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(x => x.length > 0);
  }
  return s.replace(/^['"]|['"]$/g, '');
}

export function parseFrontmatter(content) {
  const m = content && content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const kv = line.trim().match(/^([\w.-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest] = kv;

    if (rest !== '') { parent[key] = coerceScalar(rest); continue; }

    // Empty value → nested map or block list; look at the next content line.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && /^\s*-\s+/.test(lines[j])) {
      const arr = [];
      while (j < lines.length) {
        const item = lines[j].match(/^\s*-\s+(.+?)\s*$/);
        if (!item) { if (!lines[j].trim()) { j++; continue; } break; }
        arr.push(coerceScalar(item[1]));
        j++;
      }
      parent[key] = arr;
      i = j - 1;
    } else {
      const obj = {};
      parent[key] = obj;
      stack.push({ indent, obj });
    }
  }
  return root;
}

// ── todayISO: YYYY-MM-DD date string ──

export function todayISO(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === 'string') return date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// ── dateToPath: YYYY-MM-DD → "YYYY/MM/DD" (nested memory-dir segments) ──

export function dateToPath(date) {
  const [y, m, d] = todayISO(date).split('-');
  return `${y}/${m}/${d}`;
}

// ── normalizePath: cross-platform path normalization ──

export function normalizePath(p) { return p.replace(/\\/g, '/'); }

// ── inferModuleFromPath: derive a grouping "module" from a file path ──
//
// mesh/sizing.py → mesh ; src/solver/core.py → solver ; config.json → config
// Generic top-level wrapper dirs (src, lib, app, …) are skipped so the module
// reflects the meaningful subsystem, not the build layout. Returns '' for no path.

const GENERIC_DIRS = new Set([
  'src', 'lib', 'app', 'pkg', 'internal', 'source', 'sources',
  'test', 'tests', 'spec', 'scripts', 'packages',
]);

export function inferModuleFromPath(file) {
  if (!file) return '';
  const segs = normalizePath(file).split('/').filter(s => s && s !== '.' && s !== '..');
  if (segs.length === 0) return '';
  if (segs.length === 1) return segs[0].replace(/\.[^.]+$/, '') || '';
  const dirs = segs.slice(0, -1);
  for (const seg of dirs) {
    if (!GENERIC_DIRS.has(seg.toLowerCase())) return seg;
  }
  // All dirs are generic wrappers (src/, lib/, …) → the wrapper name is
  // meaningless for grouping, so fall back to the file's basename.
  return segs[segs.length - 1].replace(/\.[^.]+$/, '') || segs[segs.length - 1];
}

// ── SR finding regex patterns (contract between sharp-review and rem) ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;
export const SR_ID_PARSE_RE = /^SR-(\d{8})-(\d{3})$/;
export const SR_FINDING_HDR_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
export const SR_STATUS_RE = /^\s*-?\s*\*\*Status:\*\*\s*(\w+)/m;

// ── Review Frontmatter ──

export function reviewFrontmatter(findings, date) {
  const count = Array.isArray(findings) ? findings.length : 0;
  const desc = `Sharp review findings — ${count} total`;
  return [
    '---',
    `name: sharp-review-${date}`,
    `description: ${desc}`,
    'metadata:',
    '  type: project',
    '---',
  ].join('\n');
}

// ── Markdown parsing ──

export function parseFindingsFromMarkdown(content, date) {
  const findings = [];
  const blocks = content.split(/\n(?=###\s+\[SR-)/);
  for (const block of blocks) {
    const hdr = block.match(SR_FINDING_HDR_RE);
    if (!hdr) continue;
    const statusMatch = block.match(SR_STATUS_RE);
    const status = statusMatch ? statusMatch[1].toLowerCase() : 'open';
    const resolvedDate = status === 'fixed' ? date : null;
    const file = hdr[3].trim();
    const moduleMatch = block.match(/^\s*-?\s*\*\*Module:\*\*\s*(.+)/m);
    findings.push({
      id: hdr[1],
      severity: hdr[2],
      file,
      summary: hdr[4].trim(),
      status,
      discovered: hdr[1].slice(3, 11).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      resolvedDate,
      category: 'Bug',
      module: moduleMatch ? moduleMatch[1].trim() : inferModuleFromPath(file),
      suggestion: '',
      detail: '',
    });
  }
  return findings;
}
