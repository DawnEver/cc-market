// rem migration to the current format. Idempotent: a second run plans nothing.
//   - .gitignore gains the ignores for what rem generates (additive).
//   - Every memory entry's frontmatter loses the volatile fields (accessed, tier, count):
//     memory is immutable once written, so nothing may keep rewriting it.
//   - A child scope's memory (`<dir>/.claude/memory/**`, the retired scope-split) moves ONCE into
//     the root's `.claude/memory/` at the same dated path (git mv). A name taken by a different
//     root entry gets the scope as a suffix (`<name>-<scope>.md`) and the scope's own references
//     to it are rewritten; a byte-identical copy is removed, its content already at the root.
//   - The retired generated indexes are deleted: every `.claude/rules/MEMORY.md` (it loaded on
//     every turn and nothing rebuilds it), every `.claude/meta/` copy, and a child scope's
//     `memory-index.md`. attic/, output/ and .claude/worktrees/ are never touched.
//   - The device-local state drops `scopes` and turns a crystallize `declinedAt` count into the
//     permanent `declined: true`.
//   - Reported, never acted on here: legacy checkbox files (adopt them with `todo.js adopt`;
//     the originals stay byte-identical) and HANDOFF-/PLAN-/DECISIONS- files (they stay as
//     history; a live one becomes a task only when the USER opens it).
//   node migrate.mjs [--dry-run] [<root>]   prints the plan as JSON; --dry-run writes nothing.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, rmdirSync } from 'fs';
import { join, resolve, dirname, posix } from 'path';
import { spawnSync } from 'child_process';
import { isMain } from '../shared/lib.mjs';
import { parseLegacyItems } from '../scripts/todo-lib.mjs';

// rem owns ONLY the ignores for artefacts it generates or that earlier rem versions
// generated: the derived memory-index.md, the old _meta.json shards, and the device-local memo
// store. The broader .claude structure template is global policy owned by the root `migrate`
// skill — a plugin must not blanket-ignore a host's .claude.
const REM_GENERATED_IGNORES = ['**/.claude/memory-index.md', '**/_meta.json', '**/.claude/memo/'];

export const VOLATILE_FIELDS = ['accessed', 'tier', 'count'];
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/; // the closing fence is a whole `---` line
const CLASSED_RE = /^(HANDOFF|PLAN|DECISIONS)-/;
// Never migrated: an archive is frozen source, output/ is regenerable, a worktree is another checkout.
const FROZEN_RE = /^(?:attic|output)\/|(?:^|\/)\.claude\/worktrees\//;
const CHILD_RE = /^(.+)\/\.claude\/memory\/(.+)$/;
export const ORPHAN_RE = /(?:^|\/)\.claude\/(?:rules\/MEMORY\.md|meta\/.+)$/;
const CHILD_INDEX_RE = /^.+\/\.claude\/memory-index\.md$/;
export const MIGRATE_DOOR = 'node "${CLAUDE_PLUGIN_ROOT}/migrations/migrate.mjs" (the /migrate skill)';

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

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitList = (root, args) => {
  const r = git(root, ['ls-files', '-z', ...args]);
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean).sort() : [];
};

// Tracked memory files of the root and of every child scope, repo-relative, sorted.
function memoryFiles(root) {
  return gitList(root, ['--', ':(glob)**/.claude/memory/**/*.md']).filter(p => !FROZEN_RE.test(p));
}

// Retired generated files, tracked or not (an ignored one too): `{ path, tracked }`.
export function orphanedFiles(root) {
  const specs = ['--', ':(glob)**/.claude/rules/MEMORY.md', ':(glob)**/.claude/meta/**', ':(glob)**/.claude/memory-index.md'];
  const tracked = new Set(gitList(root, specs));
  return [...new Set([...tracked, ...gitList(root, ['--others', ...specs])])]
    .filter(p => !FROZEN_RE.test(p) && (ORPHAN_RE.test(p) || CHILD_INDEX_RE.test(p)))
    .sort()
    .map(path => ({ path, tracked: tracked.has(path) }));
}

// The child scopes' tracked memory files: `{ path, scope, rel }`.
export function childScopeFiles(root) {
  return memoryFiles(root).flatMap(path => {
    const m = path.match(CHILD_RE);
    return m && !m[1].includes('/.claude/') ? [{ path, scope: m[1], rel: m[2] }] : [];
  });
}

// Where each child file lands at the root: { from, to } moves, and identical copies to drop.
function planMoves(root, children) {
  const moves = [], drops = [], taken = new Set();
  for (const { path, scope, rel } of children) {
    let to = `.claude/memory/${rel}`;
    const there = join(root, to);
    if (!taken.has(to) && existsSync(there) && readFileSync(there).equals(readFileSync(join(root, path)))) {
      drops.push(path);
      continue;
    }
    if (taken.has(to) || existsSync(there)) {
      const ext = posix.extname(rel);
      to = `.claude/memory/${rel.slice(0, rel.length - ext.length)}-${scope.replace(/\//g, '-')}${ext}`;
    }
    taken.add(to);
    moves.push({ from: path, to, scope, rel, renamed: to !== `.claude/memory/${rel}` });
  }
  return { moves, drops };
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

const stateFileOf = root => join(root, '.claude', '.rem-state.json');

// The device-local state in the current shape, or null when it already is (or there is none).
function migratedState(root) {
  let state;
  try { state = JSON.parse(readFileSync(stateFileOf(root), 'utf8')); } catch { return null; }
  const declinedAt = state.crystallize?.declinedAt;
  if (!('scopes' in state) && declinedAt === undefined) return null;
  const { scopes: _retired, ...rest } = state;
  if (declinedAt !== undefined) rest.crystallize = { declined: true };
  return rest;
}

export function planMigration(root) {
  const plan = { gitignore: missingIgnores(root), strip: [], legacyTodos: [], classified: [], moves: [], deletes: [], state: false };
  for (const rel of memoryFiles(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const { fields } = stripVolatile(text);
    if (fields.length) plan.strip.push({ path: rel, fields });
    const items = parseLegacyItems(text);
    if (items.length) plan.legacyTodos.push({ path: rel, open: items.filter(i => i.open).length, closed: items.filter(i => !i.open).length });
    const prefix = rel.split('/').pop().match(CLASSED_RE)?.[1];
    if (prefix) plan.classified.push({ path: rel, prefix });
  }
  const { moves, drops } = planMoves(root, childScopeFiles(root));
  plan.moves = moves.map(({ from, to }) => ({ from, to }));
  plan.deletes = [...drops.map(path => ({ path, tracked: true, why: 'identical to the root entry' })),
    ...orphanedFiles(root).map(o => ({ ...o, why: 'retired generated index' }))];
  plan.state = migratedState(root) !== null;
  return plan;
}

// Remove the now-empty directories under `dir` (and `dir` itself), bottom-up.
function pruneEmpty(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) pruneEmpty(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
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

  const { moves } = planMoves(projectRoot, childScopeFiles(projectRoot));
  const scopes = [...new Set(moves.map(m => m.scope))];
  for (const { from, to } of moves) {
    mkdirSync(dirname(join(projectRoot, to)), { recursive: true });
    const r = git(projectRoot, ['mv', from, to]);
    if (r.status !== 0) throw new Error(`git mv ${from} ${to} failed: ${r.stderr.trim()}`);
  }
  // A renamed entry: its own scope's references (relative to that scope's memory) follow it.
  for (const scope of scopes) {
    const renames = moves.filter(m => m.scope === scope && m.renamed).map(m => [m.rel, m.to.slice('.claude/memory/'.length)]);
    if (!renames.length) continue;
    for (const { to } of moves.filter(m => m.scope === scope)) {
      const file = join(projectRoot, to);
      const text = readFileSync(file, 'utf8');
      const next = renames.reduce((t, [a, b]) => t.split(a).join(b), text);
      if (next !== text) writeFileSync(file, next, 'utf8');
    }
  }
  if (moves.length) summary.push(`moved ${moves.length} child-scope memory file(s) into .claude/memory/ (${scopes.join(', ')})`);

  for (const { path, tracked } of plan.deletes) {
    if (tracked) {
      const r = git(projectRoot, ['rm', '-q', '-f', '--', path]);
      if (r.status !== 0) throw new Error(`git rm ${path} failed: ${r.stderr.trim()}`);
    } else {
      rmSync(join(projectRoot, path), { force: true });
    }
  }
  if (plan.deletes.length) summary.push(`deleted ${plan.deletes.length} retired file(s): ${plan.deletes.map(d => d.path).join(', ')}`);
  for (const scope of scopes) pruneEmpty(join(projectRoot, scope, '.claude', 'memory'));
  for (const meta of new Set(plan.deletes.map(d => d.path.match(/^(.*\.claude\/meta)\//)?.[1]).filter(Boolean))) {
    pruneEmpty(join(projectRoot, meta));
  }

  const state = migratedState(projectRoot);
  if (state) {
    writeFileSync(stateFileOf(projectRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
    summary.push('state: scopes dropped; a crystallize decline is now permanent');
  }
  const did = changed || plan.strip.length > 0 || moves.length > 0 || plan.deletes.length > 0 || Boolean(state);
  return { changed: did, summary, plan };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const root = resolve(args.find(a => !a.startsWith('--')) || process.cwd());
  migrate(root, { dryRun }).then(r => console.log(JSON.stringify({ dryRun, ...r }, null, 2)));
}
