// rem migration: bring a project's .claude/memory + .claude/rules up to the latest rem format.
// Idempotent — safe to re-run; no-op once a project is current.
//
// Folds in past breaking changes:
//   - volatile frontmatter fields (created/accessed/access_count/tier) → _meta.json per date dir
//   - flat YYYY-MM-DD/ memory directories → nested YYYY/MM/DD/ (migrateFlatDirs)
//   - legacy .claude/memory/tasks/** directories cleaned up
//   - stray state files left behind by plugins predating rem
//   - .gitignore entries for rem-tracked .claude/ paths (_meta.json, memory, rules)
//   - rebuildIndex for all scopes after migration

import { existsSync, rmSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stray .claude/ files left behind by plugins predating rem
const LEGACY_STATE_FILES = ['.retro_state.json'];

// Regex for flat YYYY-MM-DD directory names
const FLAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Volatile frontmatter fields to strip → move to _meta.json
const VOLATILE_FIELDS = ['created', 'accessed', 'access_count', 'tier'];

function migrateFlatDirs(projectRoot) {
  const memoryDir = join(projectRoot, '.claude', 'memory');
  if (!existsSync(memoryDir)) return { changed: false, summary: [] };

  const moved = [];
  for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !FLAT_DATE_RE.test(entry.name)) continue;
    const [y, m, d] = entry.name.split('-');
    const oldDir = join(memoryDir, entry.name);
    const newDir = join(memoryDir, y, m, d);
    mkdirSync(newDir, { recursive: true });
    for (const file of readdirSync(oldDir)) {
      renameSync(join(oldDir, file), join(newDir, file));
    }
    rmSync(oldDir, { recursive: true });
    moved.push(`${entry.name}/ → ${y}/${m}/${d}/`);
  }

  return {
    changed: moved.length > 0,
    summary: moved.length > 0 ? [`migrated ${moved.length} flat memory director${moved.length === 1 ? 'y' : 'ies'} to nested format`] : [],
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
  const m = filePath.match(/(\d{4})[\/\\](\d{2})[\/\\](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
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
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const fm = fmMatch[1];
              for (const line of fm.split('\n')) {
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

// Entries that must be in .gitignore for rem's memory/rules tracking to work:
// - .claude/*  ignored by default, then selectively un-ignored
// - .claude/rules/** tracked (shared config)
// - .claude/memory/** tracked (memory content)
// - .claude/rules/MEMORY.md ignored (device-local generated index)
// - **/_meta.json ignored (volatile metadata)
const REQUIRED_GITIGNORE_ENTRIES = [
  '.claude/*',
  '!.claude/rules/**',
  '!.claude/memory/**',
  '.claude/rules/MEMORY.md',
  '**/_meta.json',
];

function ensureGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  let lines = [];
  if (existsSync(gitignorePath)) {
    lines = readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  }

  const existing = new Set(lines.map(l => l.trim()).filter(l => l !== ''));
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter(e => !existing.has(e));

  if (missing.length === 0) return { changed: false, summary: [] };

  // Append missing entries
  for (const entry of missing) lines.push(entry);
  // Trailing newline
  lines.push('');
  writeFileSync(gitignorePath, lines.join('\n'), 'utf8');

  return {
    changed: true,
    summary: [`added ${missing.length} gitignore entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`],
  };
}

export async function migrate(projectRoot) {
  const summary = [];
  let changed = false;

  // Step 0: Migrate volatile frontmatter → _meta.json (before stamp rebuilds index)
  const volatileMigration = migrateVolatileFrontmatter(projectRoot);
  if (volatileMigration.changed) {
    changed = true;
    summary.push(...volatileMigration.summary);
  }

  // Step 1: Migrate flat YYYY-MM-DD/ memory dirs → nested YYYY/MM/DD/
  const flatMigration = migrateFlatDirs(projectRoot);
  if (flatMigration.changed) {
    changed = true;
    summary.push(...flatMigration.summary);
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

  // Step 3: Clean up legacy state files
  for (const name of LEGACY_STATE_FILES) {
    const file = join(projectRoot, '.claude', name);
    if (existsSync(file)) {
      rmSync(file);
      changed = true;
      summary.push(`removed stray legacy .claude/${name}`);
    }
  }

  // Step 4: Ensure .gitignore covers rem-tracked .claude/ paths
  const gitignore = ensureGitignore(projectRoot);
  if (gitignore.changed) {
    changed = true;
    summary.push(...gitignore.summary);
  }

  return { changed, summary };
}
