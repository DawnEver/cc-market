#!/usr/bin/env node
// scope-validate.mjs — verify scope isolation and intermediate file integrity.
//   --check (default): dry-run, print issues, exit 0 = clean
//   --fix: auto-repair missing _meta.json and MEMORY.md files
// Called by SessionStart hook (prune-memory) and stamp-memory.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { findAllScopes, loadMemoryState, rebuildIndex } from '../lib.mjs';

const args = process.argv.slice(2);
const fixMode = args.includes('--fix');
const checkMode = args.includes('--check') || (!fixMode);

function findMemoryScopes() {
  return findAllScopes();
}

function validateScope(scopeRoot) {
  const issues = [];
  const memDir = join(scopeRoot, '.claude', 'memory');
  const rulesDir = join(scopeRoot, '.claude', 'rules');
  const indexFile = join(rulesDir, 'MEMORY.md');
  const remStateFile = join(scopeRoot, '.claude', '.rem-state.json');
  const isRepoRoot = scopeRoot === findAllScopes()[0];

  // 1. memory/ directory exists
  if (!existsSync(memDir)) {
    issues.push({ scope: scopeRoot, level: 'error', msg: '.claude/memory/ missing' });
    return issues;
  }

  // 2. Each date dir with .md files must have _meta.json
  function walk(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'tasks') continue;
          walk(full);
          // After walking, check if this date dir has .md files but no _meta.json
          const hasMd = readdirSync(full, { withFileTypes: true }).some(
            e => e.isFile() && e.name.endsWith('.md')
          );
          if (hasMd && !existsSync(join(full, '_meta.json'))) {
            issues.push({ scope: scopeRoot, level: 'warn', msg: `missing _meta.json in ${relative(memDir, full).replace(/\\/g, '/')}` });
          }
        }
      }
    } catch { /* permissions */ }
  }
  walk(memDir);

  // 2b. _meta.json files must be valid JSON
  function checkMeta(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { checkMeta(full); continue; }
        if (entry.name === '_meta.json') {
          try { JSON.parse(readFileSync(full, 'utf8')); } catch {
            issues.push({ scope: scopeRoot, level: 'error', msg: `corrupt _meta.json: ${relative(memDir, full).replace(/\\/g, '/')}` });
          }
        }
      }
    } catch { /* permissions */ }
  }
  checkMeta(memDir);

  // 3. MEMORY.md exists
  if (!existsSync(indexFile)) {
    issues.push({ scope: scopeRoot, level: 'warn', msg: '.claude/rules/MEMORY.md missing' });
  }

  // 4. No cross-scope pollution in _meta.json
  const state = loadMemoryState(scopeRoot);
  for (const [relPath] of state) {
    if (relPath.includes('..')) {
      issues.push({ scope: scopeRoot, level: 'error', msg: `cross-scope path in _meta.json: ${relPath}` });
    }
  }

  // 5. Child scopes should not have .rem-state.json
  if (!isRepoRoot && existsSync(remStateFile)) {
    issues.push({ scope: scopeRoot, level: 'warn', msg: '.claude/.rem-state.json should only exist in repo root scope' });
  }

  return issues;
}

function fixScope(scopeRoot, issues) {
  const memDir = join(scopeRoot, '.claude', 'memory');

  for (const issue of issues) {
    if (issue.msg.includes('missing _meta.json')) {
      // Extract the relative path from the message
      const m = issue.msg.match(/missing _meta.json in (.+)/);
      if (m) {
        const metaFile = join(memDir, m[1], '_meta.json');
        if (!existsSync(metaFile)) {
          writeFileSync(metaFile, '{}\n', 'utf8');
          console.log(`  [fix] created ${relative(process.cwd(), metaFile)}`);
        }
      }
    }
    if (issue.msg.includes('MEMORY.md missing')) {
      rebuildIndex(scopeRoot);
      console.log(`  [fix] rebuilt MEMORY.md for ${relative(process.cwd(), scopeRoot) || '.'}`);
    }
    if (issue.msg.includes('corrupt _meta.json')) {
      const m = issue.msg.match(/corrupt _meta.json: (.+)/);
      if (m) {
        writeFileSync(join(memDir, m[1]), '{}\n', 'utf8');
        console.log(`  [fix] reset corrupt _meta.json: ${m[1]}`);
      }
    }
  }
}

// ── Main ──
const scopes = findMemoryScopes();
const allIssues = [];

for (const scope of scopes) {
  const issues = validateScope(scope);
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
