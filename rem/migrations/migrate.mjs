// rem migration: bring a project's .claude/memory + .claude/rules up to the latest rem format.
// Idempotent — safe to re-run; no-op once a project is current.
//
// Folds in two past breaking changes:
//   - memory frontmatter (name/description/created/accessed/tier) + dated YYYY/MM/DD dirs
//     (delegated to stamp-memory.js, which already does this idempotently)
//   - removal of the legacy .claude/memory/tasks/ tree, replaced by .claude/tasks/archive/YYYY/MM/DD.md

import { existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  const legacyTasksDir = join(projectRoot, '.claude', 'memory', 'tasks');
  if (existsSync(legacyTasksDir) && isEmptyDirTree(legacyTasksDir)) {
    rmSync(legacyTasksDir, { recursive: true });
    changed = true;
    summary.push('removed empty legacy .claude/memory/tasks/ (superseded by .claude/tasks/archive/)');
  }

  return { changed, summary };
}

function isEmptyDirTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isEmptyDirTree(full)) return false;
    } else {
      return false;
    }
  }
  return true;
}
