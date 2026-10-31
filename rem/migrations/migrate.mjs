// rem migration: bring a project to the tree-only memory lifecycle. Idempotent.
//
//   node migrations/migrate.mjs [<projectRoot>] [--dry-run]
//
// The tree is the only source of truth, so everything that kept per-entry state
// beside it goes, once:
//   1. every `_meta.json` (access dates, counts, tiers, `dropped` tombstones) and the
//      `.claude/meta/MEMORY.full.md` catalog are deleted;
//   2. volatile frontmatter (`accessed`, `access_count`, `count`, `tier`, `dropped`)
//      is stripped from entries — `created` stays (it is content, checked elsewhere);
//   3. the `prune` block leaves `.claude/.rem-state.json`;
//   4. entries a live entry names in `merged_from:` are retired (deleted);
//   5. every scope's MEMORY.md is regenerated, and .gitignore covers it.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, relative, resolve } from 'path';
import { isMain } from '../shared/lib.mjs';
import { atomicWriteFile } from '../shared/atomic-write.mjs';
import { findAllScopes, collectFiles, retireMemory, rebuildIndex } from '../scripts/lib.mjs';

export const VOLATILE_FIELDS = ['accessed', 'access_count', 'count', 'tier', 'dropped'];
const VOLATILE_RE = new RegExp(`^(?:${VOLATILE_FIELDS.join('|')}):.*(?:\r?\n|$)`, 'gm');
const FM_RE = /^---\r?\n[\s\S]*?\r?\n---/;

export function stripVolatile(content) {
  const m = content.match(FM_RE);
  if (!m) return content;
  return m[0].replace(VOLATILE_RE, '') + content.slice(m[0].length);
}

const GENERATED_IGNORES = ['**/.claude/rules/MEMORY.md', '**/.claude/memo/'];

export async function migrate(projectRoot, { dryRun = false } = {}) {
  const root = resolve(projectRoot);
  const rel = p => relative(root, p).replace(/\\/g, '/');
  const counts = { meta: 0, catalog: 0, stripped: 0, retired: 0, state: 0, indexes: 0, gitignore: 0 };
  const scopes = findAllScopes(root);

  for (const scope of scopes) {
    for (const file of collectFiles(join(scope, '.claude', 'memory'))) {
      if (file.endsWith('_meta.json')) {
        counts.meta++;
        if (!dryRun) unlinkSync(file);
      } else if (file.endsWith('.md')) {
        const content = readFileSync(file, 'utf8');
        const next = stripVolatile(content);
        if (next !== content) {
          counts.stripped++;
          if (!dryRun) writeFileSync(file, next, 'utf8');
        }
      }
    }
    const catalog = join(scope, '.claude', 'meta', 'MEMORY.full.md');
    if (existsSync(catalog)) {
      counts.catalog++;
      if (!dryRun) unlinkSync(catalog);
    }
    counts.retired += retireMemory(scope, { dryRun }).size;
    if (!dryRun && rebuildIndex(scope)) counts.indexes++;
  }

  const stateFile = join(root, '.claude', '.rem-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      if ('prune' in state) {
        counts.state++;
        delete state.prune;
        if (!dryRun) atomicWriteFile(stateFile, JSON.stringify(state, null, 2));
      }
    } catch { /* unreadable state is rem-hook's to rebuild */ }
  }

  const gitignore = join(root, '.gitignore');
  const lines = existsSync(gitignore) ? readFileSync(gitignore, 'utf8').split(/\r?\n/) : [];
  const missing = GENERATED_IGNORES.filter(e => !lines.some(l => l.trim() === e));
  if (missing.length) {
    counts.gitignore = missing.length;
    if (!dryRun) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      writeFileSync(gitignore, [...lines, ...(lines.length ? [''] : []), ...missing, ''].join('\n'), 'utf8');
    }
  }

  const verb = dryRun ? 'would ' : '';
  const summary = [
    counts.meta && `${verb}delete ${counts.meta} _meta.json file(s)`,
    counts.catalog && `${verb}delete ${counts.catalog} MEMORY.full.md catalog(s)`,
    counts.stripped && `${verb}strip volatile frontmatter from ${counts.stripped} entr${counts.stripped === 1 ? 'y' : 'ies'}`,
    counts.retired && `${verb}retire ${counts.retired} entr${counts.retired === 1 ? 'y' : 'ies'} named in a live merged_from`,
    counts.state && `${verb}drop the prune block from ${rel(stateFile)}`,
    counts.indexes && `regenerated ${counts.indexes} index(es)`,
    counts.gitignore && `${verb}add ${counts.gitignore} .gitignore line(s)`,
  ].filter(Boolean);
  return { changed: summary.length > 0, summary, counts, scopes: scopes.length };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.find(a => !a.startsWith('--')) || process.cwd();
  const { summary, scopes } = await migrate(root, { dryRun: args.includes('--dry-run') });
  console.log(`[rem-migrate] ${scopes} scope(s)${args.includes('--dry-run') ? ' (dry run)' : ''}`);
  for (const line of summary.length ? summary : ['already current']) console.log(`  ${line}`);
}
