// watch migration: ensure .claude/watch/ gitignore hygiene — tracked config
// and components, gitignored runtime state/logs/secrets.
// Idempotent — safe to re-run; no-op once a project is current.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Allowlist: ignore everything under .claude/watch/, then explicitly
// re-include only components/*.py and config.yaml.
//
// Placed AFTER the root template block in .gitignore. Not in
// MANAGED_GITIGNORE_LINES, so the root migrate skill leaves them alone.
const WATCH_GITIGNORE_LINES = [
  '**/.claude/watch/**',
  '!**/.claude/watch/',
  '!**/.claude/watch/components/',
  '!**/.claude/watch/components/*.py',
  '!**/.claude/watch/config.yaml',
];

// Superseded denylist-format lines — strip on sight so they don't
// accumulate across runs or coexist with the allowlist above.
const OLD_WATCH_LINES = new Set([
  '!**/.claude/watch/**',
  '**/.claude/watch/state/',
  '**/.claude/watch/logs/',
  '**/.claude/watch/trigger.json',
  '**/.claude/watch/known-good.json',
  '**/.claude/watch/staging/',
  '**/.claude/watch/config.local.yaml',
  '**/.claude/watch/components/__pycache__/',
  // root-anchored variants (pre-template projects)
  '!.claude/watch/',
  '.claude/watch/state/',
  '.claude/watch/logs/',
  '.claude/watch/trigger.json',
  '.claude/watch/known-good.json',
  '.claude/watch/staging/',
  '.claude/watch/config.local.yaml',
]);

// Comment line that typically accompanies the old watch block.
const OLD_WATCH_COMMENT = '# watch plugin — config tracked, runtime state ignored';

function ensureGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  const original = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';

  // Strip old-format watch lines and orphaned comment.
  let cleaned = original.split(/\r?\n/)
    .filter(l => !OLD_WATCH_LINES.has(l.trim()) && l.trim() !== OLD_WATCH_COMMENT)
    .join('\n');

  const lines = cleaned.split(/\r?\n/);
  const present = new Set(lines.map(l => l.trim()));

  const missing = WATCH_GITIGNORE_LINES.filter(l => !present.has(l));
  if (missing.length === 0 && cleaned === original) return { changed: false, summary: [] };

  let content = cleaned;
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';
  content += missing.join('\n') + '\n';

  writeFileSync(gitignorePath, content, 'utf8');
  return { changed: true, summary: [`ensured ${missing.length} watch gitignore line(s): ${missing.join(', ')}`] };
}

export async function migrate(projectRoot) {
  const summary = [];
  let changed = false;

  const gitignore = ensureGitignore(projectRoot);
  if (gitignore.changed) {
    changed = true;
    summary.push(...gitignore.summary);
  }

  return { changed, summary };
}
