import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, allSessionIds, deleteSession } from '../db.mjs';
import { scanAll, projectsDir } from '../scan.mjs';

// `traceme rescan [--all] [--prune]`
//   (default)  incremental: only re-parse transcripts changed since last scan
//   --all      ignore cursors and rebuild every session from scratch
//   --prune    drop DB sessions whose source transcript no longer exists
export function cmdRescan(args) {
  openDb();
  const force = args.includes('--all');
  const prune = args.includes('--prune');

  if (prune) {
    const live = liveSessionIds();
    let removed = 0;
    for (const id of allSessionIds()) {
      if (!live.has(id)) removed += deleteSession(id) ? 1 : 0;
    }
    console.log(`Pruned ${removed} session(s) with no surviving transcript.`);
  }

  const t0 = Date.now();
  const stats = scanAll({ force });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${force ? 'Full' : 'Incremental'} scan: ${stats.files} transcript(s), ${stats.scanned} parsed, ${stats.sessions} session(s) updated in ${secs}s.`);
}

function liveSessionIds() {
  const ids = new Set();
  const root = projectsDir();
  if (!existsSync(root)) return ids;
  for (const projDir of readdirSync(root)) {
    const dir = join(root, projDir);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.endsWith('.jsonl')) ids.add(name.replace(/\.jsonl$/, ''));
    }
  }
  return ids;
}
