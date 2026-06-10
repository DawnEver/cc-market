// rem migration: bring a project's .claude/memory + .claude/rules up to the latest rem format.
// Idempotent — safe to re-run; no-op once a project is current.
//
// Folds in past breaking changes:
//   - memory frontmatter (name/description/created/accessed/tier) + dated YYYY/MM/DD dirs
//     (delegated to stamp-memory.js, which already does this idempotently)
//   - resolved task archives must live at .claude/tasks/archive/YYYY/MM/DD.md — legacy
//     .claude/memory/tasks/** content and non-conforming archive rollups (e.g. YYYY/MM.md,
//     YYYY-MM.md) are folded into that layout, deduped by ID
//   - removal of stray state files left behind by plugins predating rem
//     (e.g. .claude/.retro_state.json, superseded by .claude/.rem-state.json)

import { existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { migrateLegacyArchives } from './legacy-archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stray .claude/ files left behind by plugins predating rem — safe to delete,
// their data has no successor format and was never load-bearing.
const LEGACY_STATE_FILES = ['.retro_state.json'];

export async function migrate(projectRoot) {
  const summary = [];
  let changed = false;

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

  const archives = migrateLegacyArchives(projectRoot);
  if (archives.changed) {
    changed = true;
    summary.push(...archives.summary);
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
