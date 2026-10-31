// rem migration: keep a project's .gitignore covering the artefacts rem generates.
// Idempotent and additive: it only appends missing ignore lines. It never moves,
// rewrites or deletes anything under .claude/ — a memory entry is never deleted.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// rem owns ONLY the ignores for artefacts it generates or that earlier rem versions
// generated: the old injected MEMORY.md index, the old _meta.json shards, and the
// device-local memo store. The broader .claude structure template is global policy
// owned by the root `migrate` skill — a plugin must not blanket-ignore a host's .claude.
const REM_GENERATED_IGNORES = ['**/.claude/rules/MEMORY.md', '**/_meta.json', '**/.claude/memo/'];

function ensureGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  const original = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(original.split(/\r?\n/).map(l => l.trim()));
  const missing = REM_GENERATED_IGNORES.filter(e => !present.has(e));
  if (missing.length === 0) return { changed: false, summary: [] };

  const kept = original.split(/\r?\n/);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const next = [...kept, ...(kept.length ? [''] : []), ...missing, ''].join('\n');
  writeFileSync(gitignorePath, next, 'utf8');
  return { changed: true, summary: [`ensured ${missing.length} rem gitignore ignore(s): ${missing.join(', ')}`] };
}

export async function migrate(projectRoot) {
  return ensureGitignore(projectRoot);
}
