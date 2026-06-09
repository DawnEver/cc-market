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

// ── normalizePath: cross-platform path normalization ──

export function normalizePath(p) { return p.replace(/\\/g, '/'); }

// ── SR finding regex patterns (contract between sharp-review and rem) ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;
export const SR_ID_PARSE_RE = /^SR-(\d{8})-(\d{3})$/;
export const SR_FINDING_HDR_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
export const SR_STATUS_RE = /^\s*-?\s*\*\*Status:\*\*\s*(\w+)/m;
