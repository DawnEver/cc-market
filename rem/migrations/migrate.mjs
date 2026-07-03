// rem migration: bring a project's .claude/memory + .claude/rules up to the latest rem format.
// Idempotent — safe to re-run; no-op once a project is current.
//
// Folds in past breaking changes:
//   - volatile frontmatter fields (created/accessed/access_count/tier) → _meta.json per date dir
//   - flat memory layouts → nested YYYY/MM/DD/ across all scopes (migrateFlatDirs):
//     both `YYYY-MM-DD/` dirs and date-prefixed root files (`YYYY-MM-DD_slug.md`)
//   - legacy task directories (.claude/tasks/, .claude/memory/tasks/) removed
//     across all scopes (cleanupLegacyTasks) — the task system was retired; tasks
//     now live solely in sharp-review findings
//   - stray state files left behind by plugins predating rem
//   - .gitignore entries for rem-tracked .claude/ paths (_meta.json, memory, rules)
//   - rebuildIndex for all scopes after migration
//
// Retirement: all steps target pre-1.1 project layouts — once every active project has
// been migrated past rem 1.2, delete the legacy steps and keep only the gitignore +
// rebuildIndex maintenance passes.

import { existsSync, rmSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from "../shared/spawn.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stray .claude/ files left behind by plugins predating rem
const LEGACY_STATE_FILES = ['.retro_state.json'];

// Regex for flat YYYY-MM-DD directory names
const FLAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Volatile frontmatter fields to strip → move to _meta.json
const VOLATILE_FIELDS = ['created', 'accessed', 'access_count', 'tier'];

// Migrate legacy flat memory layouts → nested YYYY/MM/DD/ across EVERY scope.
// Handles two shapes: flat `YYYY-MM-DD/` dirs, and date-prefixed files sitting
// directly under memory/ (e.g. `2026-06-02_ci_ruff_checks.md`). Like
// migrateVolatileFrontmatter/cleanupLegacyTasks, this must recurse nested scopes
// (monorepo sub-projects) — not just projectRoot — or their flat layouts are
// silently left behind while their frontmatter gets migrated.
function migrateFlatDirs(projectRoot) {
  const moved = [];
  for (const scope of findAllMemoryScopes(projectRoot)) {
    const memoryDir = join(scope, '.claude', 'memory');
    if (!existsSync(memoryDir)) continue;
    const prefix = scope === projectRoot ? '' : scope.slice(projectRoot.length + 1).replace(/\\/g, '/') + '/';
    for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
      if (entry.isDirectory() && FLAT_DATE_RE.test(entry.name)) {
        const [y, m, d] = entry.name.split('-');
        const oldDir = join(memoryDir, entry.name);
        const newDir = join(memoryDir, y, m, d);
        mkdirSync(newDir, { recursive: true });
        for (const file of readdirSync(oldDir)) {
          renameSync(join(oldDir, file), join(newDir, file));
        }
        rmSync(oldDir, { recursive: true });
        moved.push(`${prefix}${entry.name}/ → ${prefix}${y}/${m}/${d}/`);
        continue;
      }
      // Date-prefixed file directly under memory/ → strip prefix into a date dir.
      const fileMatch = entry.isFile() && entry.name.match(/^(\d{4})-(\d{2})-(\d{2})[-_](.+)$/);
      if (fileMatch) {
        const [, y, m, d, rest] = fileMatch;
        const dest = join(memoryDir, y, m, d, rest);
        if (existsSync(dest)) continue; // never clobber an existing nested file
        mkdirSync(join(memoryDir, y, m, d), { recursive: true });
        renameSync(join(memoryDir, entry.name), dest);
        moved.push(`${prefix}${entry.name} → ${prefix}${y}/${m}/${d}/${rest}`);
      }
    }
  }

  return {
    changed: moved.length > 0,
    summary: moved.length > 0 ? [`migrated ${moved.length} flat memory entr${moved.length === 1 ? 'y' : 'ies'} to nested format`] : [],
  };
}

// Remove retired task directories across every scope. The task system was removed
// (tasks now live in sharp-review findings) — these dirs are dead weight. Idempotent.
function cleanupLegacyTasks(projectRoot) {
  const removed = [];
  // findAllMemoryScopes keys off .claude/memory; also check projectRoot's bare .claude.
  const scopes = new Set(findAllMemoryScopes(projectRoot));
  scopes.add(projectRoot);
  for (const scope of scopes) {
    for (const rel of [join('.claude', 'tasks'), join('.claude', 'memory', 'tasks')]) {
      const dir = join(scope, rel);
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      const label = scope === projectRoot ? rel : join(scope.slice(projectRoot.length + 1), rel);
      removed.push(label.replace(/\\/g, '/'));
    }
  }
  return {
    changed: removed.length > 0,
    summary: removed.length > 0 ? [`removed ${removed.length} legacy task dir(s): ${removed.join(', ')}`] : [],
  };
}

function findAllMemoryScopes(root) {
  const scopes = [root];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const sub = join(dir, entry.name);
          if (existsSync(join(sub, '.claude', 'memory'))) scopes.push(sub);
          walk(sub, depth + 1);
        }
      }
    } catch { /* permissions */ }
  }
  walk(root, 0);
  return scopes;
}

function extractDateFromPath(filePath) {
  // Preferred: nested YYYY/MM/DD/ directory layout.
  const nested = filePath.match(/(\d{4})[\/\\](\d{2})[\/\\](\d{2})/);
  if (nested) return `${nested[1]}-${nested[2]}-${nested[3]}`;
  // Fallback: a YYYY-MM-DD token (e.g. a date-prefixed filename like
  // `2026-06-02_ci_ruff_checks.md`) — keeps undated _meta out of the 1970 bucket.
  const token = filePath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (token) return `${token[1]}-${token[2]}-${token[3]}`;
  return null;
}

function migrateVolatileFrontmatter(projectRoot) {
  const summary = [];
  let changed = false;
  const scopes = findAllMemoryScopes(projectRoot);

  for (const scope of scopes) {
    const memDir = join(scope, '.claude', 'memory');
    if (!existsSync(memDir)) continue;

    const metaByDate = new Map(); // dateStr → { slug: meta }

    function walk(dir) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'tasks') continue;
            walk(full);
          } else if (entry.name.endsWith('.md')) {
            const content = readFileSync(full, 'utf8');
            let hasVolatile = false;
            let accessed = null, count = 1, tier = 'short', created = null;

            // Check for volatile fields in frontmatter
            const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (fmMatch) {
              const fm = fmMatch[1];
              for (const line of fm.split(/\r?\n/)) {
                const kv = line.match(/^(\w+):\s*(.*)/);
                if (!kv) continue;
                if (kv[1] === 'accessed') { accessed = kv[2].trim(); hasVolatile = true; }
                if (kv[1] === 'access_count') { count = parseInt(kv[2].trim(), 10) || 1; hasVolatile = true; }
                if (kv[1] === 'tier') { tier = kv[2].trim(); hasVolatile = true; }
                if (kv[1] === 'created') { created = kv[2].trim(); hasVolatile = true; }
              }
            }

            const dateStr = extractDateFromPath(full) || (created || '1970-01-01');
            const slug = entry.name;

            if (!metaByDate.has(dateStr)) metaByDate.set(dateStr, {});
            metaByDate.get(dateStr)[slug] = {
              accessed: accessed || dateStr,
              count,
              tier,
            };

            // Strip volatile fields from frontmatter
            if (hasVolatile) {
              let updated = content;
              for (const field of VOLATILE_FIELDS) {
                updated = updated.replace(new RegExp(`^${field}:.*\n?`, 'm'), '');
              }
              writeFileSync(full, updated, 'utf8');
              changed = true;
            }
          }
        }
      } catch { /* permissions */ }
    }
    walk(memDir);

    // Also handle files on disk not in index → mark as pre-migration-evicted
    // (we don't have old index to compare against, so check existing _meta.json)
    for (const [dateStr, entries] of metaByDate) {
      const [y, m, d] = dateStr.split('-');
      const metaFile = join(memDir, y, m, d, '_meta.json');

      let existing = {};
      if (existsSync(metaFile)) {
        try { existing = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* start fresh */ }
      }

      // Merge: don't overwrite existing entries
      for (const [slug, meta] of Object.entries(entries)) {
        if (!existing[slug]) {
          existing[slug] = meta;
        }
      }

      if (Object.keys(entries).length > 0) {
        mkdirSync(dirname(metaFile), { recursive: true });
        writeFileSync(metaFile, JSON.stringify(existing, null, 2), 'utf8');
      }
    }
  }

  if (changed) summary.push('migrated volatile frontmatter fields to _meta.json per scope');
  return { changed, summary };
}

// rem owns ONLY the ignores for the two artifacts it generates: the device-local
// MEMORY.md index and the volatile _meta.json shards. The broader .claude structure
// template (base `**/.claude/**` exclusion + agents/skills/commands/workflows/settings
// re-includes) is global Claude-Code policy owned by the root `migrate` skill — a
// plugin must not blanket-ignore a host project's .claude. These two lines are plain
// ignores valid in any project (no re-include ordering needed), and the root skill,
// when present, already emits them LAST in its template, so this no-ops there.
//
// Consequence: rem alone does NOT repair a broken structure block (e.g. a dir-only
// `!**/.claude/memory/` that leaves nested files ignored). That fix lives in the root
// `migrate` skill's CLAUDE_GITIGNORE_TEMPLATE — run `migrate` to apply it. A project
// that only installs rem just gets its two generated artifacts ignored.
const REM_GENERATED_IGNORES = ['**/.claude/rules/MEMORY.md', '**/_meta.json'];

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
  const summary = [];
  let changed = false;

  // Step 0: Migrate flat YYYY-MM-DD/ memory dirs → nested YYYY/MM/DD/.
  // Must precede volatile migration so extractDateFromPath sees nested paths and
  // routes each file's _meta.json to the correct YYYY/MM/DD/ shard.
  const flatMigration = migrateFlatDirs(projectRoot);
  if (flatMigration.changed) {
    changed = true;
    summary.push(...flatMigration.summary);
  }

  // Step 1: Migrate volatile frontmatter → _meta.json (before stamp rebuilds index)
  const volatileMigration = migrateVolatileFrontmatter(projectRoot);
  if (volatileMigration.changed) {
    changed = true;
    summary.push(...volatileMigration.summary);
  }

  // Step 2: Run stamp-memory to rebuild indexes
  const stampScript = join(__dirname, '..', 'scripts', 'stamp-memory.js');
  if (existsSync(stampScript) && existsSync(join(projectRoot, '.claude'))) {
    try {
      const out = execFileSync('node', [stampScript], { cwd: projectRoot, encoding: 'utf8' });
      if (/\[stamp-memory\]/.test(out)) {
        changed = true;
        summary.push('rebuilt MEMORY.md indexes for all scopes');
      }
    } catch { /* stamp failed — non-fatal */ }
  }

  // Step 3: Remove retired task directories across all scopes
  const taskCleanup = cleanupLegacyTasks(projectRoot);
  if (taskCleanup.changed) {
    changed = true;
    summary.push(...taskCleanup.summary);
  }

  // Step 4: Clean up legacy state files
  for (const name of LEGACY_STATE_FILES) {
    const file = join(projectRoot, '.claude', name);
    if (existsSync(file)) {
      rmSync(file);
      changed = true;
      summary.push(`removed stray legacy .claude/${name}`);
    }
  }

  // Step 5: Ensure .gitignore covers rem-tracked .claude/ paths
  const gitignore = ensureGitignore(projectRoot);
  if (gitignore.changed) {
    changed = true;
    summary.push(...gitignore.summary);
  }

  return { changed, summary };
}
