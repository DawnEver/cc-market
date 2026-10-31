// rem migration to the four layers (rules, docs, memory, tasks). Idempotent; NOTHING is deleted.
//   - .gitignore gains the ignores for what rem generates (additive).
//   - Every memory entry's frontmatter loses the volatile fields (accessed, tier, count):
//     memory is immutable once written, so nothing may keep rewriting it.
//   - Reported, never acted on here: legacy checkbox files (adopt them with `todo.js adopt`;
//     the originals stay byte-identical) and HANDOFF-/PLAN-/DECISIONS- files (they stay as
//     history; a live one becomes a task only when the USER opens it).
//   node migrate.mjs [--dry-run] [<root>]   prints the plan as JSON; --dry-run writes nothing.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { isMain } from '../shared/lib.mjs';
import { parseLegacyItems } from '../scripts/todo-lib.mjs';

// rem owns ONLY the ignores for artefacts it generates or that earlier rem versions
// generated: the derived memory-index.md, the old injected rules/MEMORY.md, the old
// _meta.json shards, and the device-local memo store. The broader .claude structure template is global policy
// owned by the root `migrate` skill — a plugin must not blanket-ignore a host's .claude.
const REM_GENERATED_IGNORES = ['**/.claude/memory-index.md', '**/.claude/rules/MEMORY.md', '**/_meta.json', '**/.claude/memo/'];

export const VOLATILE_FIELDS = ['accessed', 'tier', 'count'];
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/; // the closing fence is a whole `---` line
const CLASSED_RE = /^(HANDOFF|PLAN|DECISIONS)-/;

function readGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  return existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
}

function missingIgnores(projectRoot) {
  const present = new Set(readGitignore(projectRoot).split(/\r?\n/).map(l => l.trim()));
  return REM_GENERATED_IGNORES.filter(e => !present.has(e));
}

function ensureGitignore(projectRoot) {
  const missing = missingIgnores(projectRoot);
  if (missing.length === 0) return { changed: false, summary: [] };
  const kept = readGitignore(projectRoot).split(/\r?\n/);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const next = [...kept, ...(kept.length ? [''] : []), ...missing, ''].join('\n');
  writeFileSync(join(projectRoot, '.gitignore'), next, 'utf8');
  return { changed: true, summary: [`ensured ${missing.length} rem gitignore ignore(s): ${missing.join(', ')}`] };
}

// Tracked memory files of every scope (`**/.claude/memory/**`), repo-relative, sorted.
function memoryFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ':(glob)**/.claude/memory/**/*.md'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return [];
  return r.stdout.split('\0').filter(Boolean).sort();
}

function stripVolatile(text) {
  const m = text.match(FM_RE);
  if (!m) return { text, fields: [] };
  const fields = [];
  const kept = m[1].split(/\r?\n/).filter(line => {
    const key = line.match(/^(\w+):/)?.[1];
    if (VOLATILE_FIELDS.includes(key)) { fields.push(key); return false; }
    return true;
  });
  const eol = m[0].includes('\r\n') ? '\r\n' : '\n';
  return { text: `---${eol}${kept.join(eol)}${eol}---` + text.slice(m[0].length), fields };
}

export function planMigration(root) {
  const plan = { gitignore: missingIgnores(root), strip: [], legacyTodos: [], classified: [], deletes: [] };
  for (const rel of memoryFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const { fields } = stripVolatile(text);
    if (fields.length) plan.strip.push({ path: rel, fields });
    const items = parseLegacyItems(text);
    if (items.length) plan.legacyTodos.push({ path: rel, open: items.filter(i => i.open).length, closed: items.filter(i => !i.open).length });
    const prefix = rel.split('/').pop().match(CLASSED_RE)?.[1];
    if (prefix) plan.classified.push({ path: rel, prefix });
  }
  return plan;
}

export async function migrate(projectRoot, { dryRun = false } = {}) {
  const plan = planMigration(projectRoot);
  if (dryRun) return { changed: false, summary: [], plan };
  const { changed, summary } = ensureGitignore(projectRoot);
  for (const { path } of plan.strip) {
    const file = join(projectRoot, path);
    writeFileSync(file, stripVolatile(readFileSync(file, 'utf8')).text, 'utf8');
  }
  if (plan.strip.length) summary.push(`stripped volatile frontmatter from ${plan.strip.length} memory file(s)`);
  return { changed: changed || plan.strip.length > 0, summary, plan };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const root = resolve(args.find(a => !a.startsWith('--')) || process.cwd());
  migrate(root, { dryRun }).then(r => console.log(JSON.stringify({ dryRun, ...r }, null, 2)));
}
