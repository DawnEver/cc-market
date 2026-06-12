import { existsSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';

export const TRACEME_DIR = join(homedir(), '.claude', 'traceme');

export function getDbPath() {
  return process.env.TRACEME_DB_PATH || join(TRACEME_DIR, 'traceme.db');
}
export const ERROR_LOG = join(TRACEME_DIR, 'error.log');

export { todayISO } from '../shared/lib.mjs';

// ── Formatting helpers (shared by insights / dashboard) ──

export function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
export function fmtCost(n) { return '$' + n.toFixed(4); }
export function fmtDuration(min) {
  if (min < 1) return '<1m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export function daysArray(from, to) {
  const days = [];
  const d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return days;
}

// ── Tool categorization for the Plugins/Subagents/MCPs breakdown ──
// Mirrors how Claude's native status insights buckets token usage.
export function categorizeTool(toolName, skillName) {
  if (!toolName) return 'builtin';
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (toolName === 'Task' || toolName === 'Agent') return 'subagent';
  if (toolName === 'Skill' && skillName && skillName.includes(':')) return 'plugin';
  return 'builtin';
}

export function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

export function getProjectRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return cwd;
  }
}

export function getProjectName(cwd) {
  return basename(getProjectRoot(cwd));
}

export function summarizeToolInput(toolName, toolInput) {
  if (!toolInput) return '';
  const str = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
  return str.slice(0, 200);
}

export function getGitRemote(cwd) {
  try {
    return execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

export function normalizeRemoteUrl(url) {
  let normalized = url.trim();
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/^git@([^:]+):/, '$1/');
  normalized = normalized.replace(/\.git$/, '');
  normalized = normalized.replace(/\/$/, '');
  return normalized.toLowerCase();
}

export function rotateErrorLog(maxSize = 1_000_000) {
  try {
    if (existsSync(ERROR_LOG)) {
      const stats = statSync(ERROR_LOG);
      if (stats.size > maxSize) {
        const oldPath = ERROR_LOG + '.old';
        try { renameSync(oldPath, oldPath + '.bak'); } catch {}
        try { renameSync(ERROR_LOG, oldPath); } catch {}
      }
    }
  } catch {}
}
