#!/usr/bin/env node
// scope-validate.mjs — verify each memory scope's integrity.
//   --check (default): print issues, exit 1 on an error
//   --fix: regenerate stale indexes
// Errors: a scope without .claude/memory/.
// Warnings: a leftover _meta.json (nothing reads it), a stale or missing index, an entry outside YYYY/MM/DD/, a child-scope state file.

import { readFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { findAllScopes, collectFiles, renderIndex, rebuildIndex, indexFilePath, DATED_RE } from './lib.mjs';

const args = process.argv.slice(2);
const fixMode = args.includes('--fix');
const checkMode = args.includes('--check') || (!fixMode);

function findMemoryScopes() {
  return findAllScopes();
}

function validateScope(scopeRoot, isRepoRoot) {
  const issues = [];
  const memDir = join(scopeRoot, '.claude', 'memory');
  const indexFile = indexFilePath(scopeRoot);
  const add = (level, msg) => issues.push({ scope: scopeRoot, level, msg });

  if (!existsSync(memDir)) { add('error', '.claude/memory/ missing'); return issues; }

  for (const abs of collectFiles(memDir)) {
    const rel = relative(memDir, abs).replace(/\\/g, '/');
    if (rel.endsWith('/_meta.json') || rel === '_meta.json') add('warn', `leftover _meta.json: ${rel} — nothing reads it`);
    else if (rel.endsWith('.md') && !rel.startsWith('tasks/') && !DATED_RE.test(rel)) add('warn', `entry outside a dated directory: ${rel}`);
  }

  let current = null;
  try { current = readFileSync(indexFile, 'utf8'); } catch { /* missing */ }
  if (current === null) add('warn', '.claude/memory-index.md missing');
  else if (current !== renderIndex(scopeRoot)) add('warn', '.claude/memory-index.md stale');

  if (!isRepoRoot && existsSync(join(scopeRoot, '.claude', '.rem-state.json'))) {
    add('warn', '.claude/.rem-state.json should only exist in repo root scope');
  }
  return issues;
}

function fixScope(scopeRoot, issues) {
  if (issues.some(i => i.msg.startsWith('.claude/memory-index.md'))) {
    rebuildIndex(scopeRoot);
    console.log(`  [fix] regenerated memory-index.md for ${relative(process.cwd(), scopeRoot) || '.'}`);
  }
}

// ── Main ──
const scopes = findMemoryScopes();
const allIssues = [];

for (const scope of scopes) {
  const issues = validateScope(scope, scope === scopes[0]);
  allIssues.push(...issues);
}

if (allIssues.length === 0) {
  console.log(`[scope-validate] ${scopes.length} scope(s) — clean`);
  process.exit(0);
}

const label = checkMode ? 'issues' : 'fixing';
console.log(`[scope-validate] ${allIssues.length} ${label} across ${scopes.length} scope(s):`);

for (const issue of allIssues) {
  const relScope = relative(process.cwd(), issue.scope).replace(/\\/g, '/') || '.';
  console.log(`  [${issue.level}] ${relScope}: ${issue.msg}`);
}

if (fixMode) {
  // Group issues by scope
  const byScope = new Map();
  for (const issue of allIssues) {
    if (!byScope.has(issue.scope)) byScope.set(issue.scope, []);
    byScope.get(issue.scope).push(issue);
  }
  for (const [scope, issues] of byScope) {
    fixScope(scope, issues);
  }
  console.log('[scope-validate] fixes applied');
}

if (checkMode) {
  const errors = allIssues.filter(i => i.level === 'error');
  process.exit(errors.length > 0 ? 1 : 0);
}
