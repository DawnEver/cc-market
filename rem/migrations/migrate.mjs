// rem migration: bring a project's .claude/memory + .claude/rules up to the latest rem format.
// Idempotent — safe to re-run; no-op once a project is current.
//
// Folds in past breaking changes:
//   - memory frontmatter (name/description/created/accessed/tier) + dated YYYY/MM/DD dirs
//     (delegated to stamp-memory.js, which already does this idempotently)
//   - flat YYYY-MM-DD/ memory directories → nested YYYY/MM/DD/ (migrateFlatDirs)
//   - legacy .claude/memory/tasks/** directories cleaned up
//   - removal of stray state files left behind by plugins predating rem
//     (e.g. .claude/.retro_state.json, superseded by .claude/.rem-state.json)

import { existsSync, rmSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';


const __dirname = dirname(fileURLToPath(import.meta.url));

// Stray .claude/ files left behind by plugins predating rem — safe to delete,
// their data has no successor format and was never load-bearing.
const LEGACY_STATE_FILES = ['.retro_state.json'];

// Regex for flat YYYY-MM-DD directory names (legacy, must be migrated to nested YYYY/MM/DD/)
const FLAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export async function migrate(projectRoot) {
  const summary = [];
  let changed = false;

  // Step 1: Migrate flat YYYY-MM-DD/ memory dirs → nested YYYY/MM/DD/ (before stamp-memory
  // re-indexes them — so stamp-memory sees the correct nested paths).
  const flatMigration = migrateFlatDirs(projectRoot);
  if (flatMigration.changed) {
    changed = true;
    summary.push(...flatMigration.summary);
  }

  const stampScript = join(__dirname, '..', 'scripts', 'stamp-memory.js');
  if (existsSync(stampScript) && existsSync(join(projectRoot, '.claude'))) {
    const out = execFileSync('node', [stampScript], { cwd: projectRoot, encoding: 'utf8' });
    const stamped = out.match(/\[stamp-memory\]\s+(\d+)\s+stamped/);
    if (stamped && Number(stamped[1]) > 0) {
      changed = true;
      summary.push(`stamped ${stamped[1]} memory file(s) with missing frontmatter`);
    }
    if (/\[stamp-memory\]\s+added\s+\d+\s+entries/.test(out)) {
      changed = true;
      summary.push('added newly-discovered memory files to MEMORY.md index');
    }
    if (/\[stamp-memory\]\s+removed\s+\d+\s+broken entries/.test(out)) {
      changed = true;
      summary.push('removed broken entries from MEMORY.md index');
    }
  }

  for (const name of LEGACY_STATE_FILES) {
    const file = join(projectRoot, '.claude', name);
    if (existsSync(file)) {
      rmSync(file);
      changed = true;
      summary.push(`removed stray legacy .claude/${name}`);
    }
  }

  return { changed, summary };
}
