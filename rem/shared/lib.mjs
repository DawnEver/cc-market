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
