#!/usr/bin/env node
// scope-validate.mjs — rem's doctor: verify the root memory's integrity.
//   --check (default): print issues, exit 1 on an error
//   --fix: regenerate a stale index
// Errors: no .claude/memory/; a task whose TASK.md lacks the user authority id that /rem:task
// open records (TASK.md written around the library); a child scope's memory or a retired
// generated index (`.claude/rules/MEMORY.md`, `.claude/meta/`) -- each names the rem migration.
// Warnings: a leftover _meta.json (nothing reads it), a stale or missing index, an entry outside
// YYYY/MM/DD/, a task journal minting one ID twice.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { authorityProblem } from './authority.mjs';
import { duplicateIds } from './tasks.mjs';
import { memoryRoot, collectFiles, renderIndex, rebuildIndex, indexFilePath, DATED_RE } from './lib.mjs';
import { childScopeFiles, orphanedFiles, MIGRATE_DOOR } from '../migrations/migrate.mjs';

const args = process.argv.slice(2);
const fixMode = args.includes('--fix');
const checkMode = args.includes('--check') || (!fixMode);

function validateRoot(root) {
  const issues = [];
  const memDir = join(root, '.claude', 'memory');
  const add = (level, msg) => issues.push({ level, msg });

  if (!existsSync(memDir)) { add('error', '.claude/memory/ missing'); return issues; }

  for (const abs of collectFiles(memDir)) {
    const rel = relative(memDir, abs).replace(/\\/g, '/');
    if (rel.endsWith('/_meta.json') || rel === '_meta.json') add('warn', `leftover _meta.json: ${rel} — nothing reads it`);
    else if (rel.endsWith('.md') && !rel.startsWith('tasks/') && !DATED_RE.test(rel)) add('warn', `entry outside a dated directory: ${rel}`);
  }

  let current = null;
  try { current = readFileSync(indexFilePath(root), 'utf8'); } catch { /* missing */ }
  if (current === null) add('warn', '.claude/memory-index.md missing');
  else if (current !== renderIndex(root)) add('warn', '.claude/memory-index.md stale');

  const scopes = [...new Set(childScopeFiles(root).map(f => f.scope))];
  if (scopes.length) {
    add('error', `child-scope memory in ${scopes.join(', ')}: memory lives at the root and nothing reads a child scope. Door: ${MIGRATE_DOOR} moves it once`);
  }
  const orphans = orphanedFiles(root).map(o => o.path);
  if (orphans.length) {
    add('error', `retired generated index(es) ${orphans.join(', ')}: nothing rebuilds them, and rules/MEMORY.md loads on every turn. Door: ${MIGRATE_DOOR} deletes them`);
  }

  for (const { level, msg } of taskAuthorityIssues(root)) add(level, msg);
  return issues;
}

// Detection behind the authority check: a task opened by /rem:task carries the consumed
// record id in TASK.md (`authority:`) and in its journal's opened line.
function taskAuthorityIssues(root) {
  const dir = join(root, '.claude', 'tasks');
  if (!existsSync(dir)) return [];
  const out = []; // { level, msg }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const read = f => { try { return readFileSync(join(dir, e.name, f), 'utf8'); } catch { return ''; } };
    const dup = duplicateIds(read('JOURNAL.md'));
    if (dup.length) out.push({ level: 'warn', msg: `task ${e.name}: duplicate journal IDs ${dup.join(', ')} -- a citation of one is ambiguous; correct with task.js amend` });
    const id = read('TASK.md').match(/^authority: ([0-9a-f]{12})\s*$/m)?.[1];
    const opened = id && new RegExp(`^- \\d{4}-\\d{2}-\\d{2} opened: .*\\(authority ${id}\\)\\s*$`, 'm').test(read('JOURNAL.md'));
    if (!opened) { out.push({ level: 'error', msg: `task ${e.name} has no user authority — its TASK.md was not written by /rem:task open` }); continue; }
    const problem = authorityProblem(root, e.name, id);
    if (problem) out.push({ level: problem.level, msg: `task ${e.name}: ${problem.msg}${problem.level === 'error' ? ' — opened around /rem:task (see git log of its TASK.md)' : ''}` });
  }
  return out;
}

// ── Main ──
const root = memoryRoot();
const issues = validateRoot(root);

if (issues.length === 0) {
  console.log('[scope-validate] .claude/memory — clean');
  process.exit(0);
}

console.log(`[scope-validate] ${issues.length} ${checkMode ? 'issues' : 'fixing'}:`);
for (const issue of issues) console.log(`  [${issue.level}] ${issue.msg}`);

if (fixMode) {
  if (issues.some(i => i.msg.startsWith('.claude/memory-index.md'))) {
    rebuildIndex(root);
    console.log('  [fix] regenerated .claude/memory-index.md');
  }
  console.log('[scope-validate] fixes applied');
}

if (checkMode) process.exit(issues.some(i => i.level === 'error') ? 1 : 0);
