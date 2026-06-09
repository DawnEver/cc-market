import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';

export const TRACEME_DIR = join(homedir(), '.claude', 'traceme');

export function getDbPath() {
  return process.env.TRACEME_DB_PATH || join(TRACEME_DIR, 'traceme.db');
}
export const ERROR_LOG = join(TRACEME_DIR, 'error.log');

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
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
