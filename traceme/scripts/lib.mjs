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
