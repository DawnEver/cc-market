// shared/stamp.mjs — memory index (MEMORY.md) entry primitives + single-entry upsert
// Single source of truth for the index entry line format, shared by rem (full
// rebuildIndex) and sharp-review (post-review upsert). Keeping the format here
// lets sharp-review stamp its own entry without resolving the rem plugin dir.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

function parseDate(s) { return new Date(s).getTime(); }

// Legacy flat `YYYY-MM-DD/slug.md` → nested `YYYY/MM/DD/slug.md`
export function normalizeMemoryPath(relPath) {
  return relPath.replace(/^(\d{4})-(\d{2})-(\d{2})\//, '$1/$2/$3/');
}

// Matches and parses one index entry line
export const ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\s+(.+?)\]\(\.\.\/memory\/(.+?\.md)\)\s*—\s*`created:\s*(\d{4}-\d{2}-\d{2}),\s*accessed:\s*(\d{4}-\d{2}-\d{2})`/;

export function parseIndexEntry(line) {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  return {
    date: m[1],
    title: m[2],
    path: normalizeMemoryPath(m[3]),
    created: m[4],
    accessed: m[5],
    accessedDate: parseDate(m[5]),
    line,
  };
}

export function formatIndexEntry(entry) {
  return `- [${entry.date} ${entry.title}](../memory/${entry.path}) — \`created: ${entry.created}, accessed: ${entry.accessed}\``;
}

export function parseIndex(content) {
  const lines = content.split('\n');
  const header = [];
  const entries = [];
  for (const line of lines) {
    const e = parseIndexEntry(line);
    if (e) {
      entries.push(e);
    } else if (entries.length === 0) {
      header.push(line);
    }
  }
  return { header, entries };
}

// ── upsertIndexEntry: insert/replace ONE entry in a scope's MEMORY.md ──
//
// Minimal stamp for writers that produce a single memory file (e.g. sharp-review's
// post-review.js). Does not touch _meta.json or other scopes — rem's rebuildIndex()
// regenerates the full index on the next session start, so a plain upsert here only
// needs to keep the index coherent until then. Creates a minimal index if missing.

export function upsertIndexEntry(scopeRoot, relPath, { name, date }) {
  const rulesDir = join(scopeRoot, '.claude', 'rules');
  const indexFile = join(rulesDir, 'MEMORY.md');
  const path = normalizeMemoryPath(relPath);

  const content = existsSync(indexFile)
    ? readFileSync(indexFile, 'utf8')
    : '# Memory Index\n\n## Entries';
  const { header, entries } = parseIndex(content);

  const dateInPath = path.match(/^(\d{4})\/(\d{2})\/(\d{2})\//);
  const created = dateInPath ? `${dateInPath[1]}-${dateInPath[2]}-${dateInPath[3]}` : date;
  const entry = { date, title: name, path, created, accessed: date };

  const kept = entries.filter(e => e.path !== path);
  const headerLines = header
    .filter(l => l.trim() !== '_(no entries)_')
    .join('\n').replace(/\s+$/, '').split('\n');

  const lines = [...headerLines, formatIndexEntry(entry), ...kept.map(e => e.line)];
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(indexFile, lines.join('\n') + '\n', 'utf8');
}
