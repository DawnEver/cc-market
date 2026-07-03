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
