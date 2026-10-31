#!/usr/bin/env node
// Fold duplicate memory entries into ONE new entry. Memory keeps everything and an
// entry is never edited: the sources stay byte-identical on disk, and the new entry
// names them in `merged_from:`, which hides them from recall and the derived index.
//
//   node merge-memory.js --name <kebab-slug> --from <a.md,b.md,...> [--description <text>] [--dry-run]
//
// The new entry is .claude/memory/<today>/<slug>.md. Each source's full body (every
// measurement, number and quote) is copied verbatim under `## From <path>`. The write
// is refused if any non-blank source line would be missing from the result.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  findMemoryScope, parseFrontmatter, rebuildIndex, dateToPath, formatRefs, listEntries, writeOnce,
} from './lib.mjs';

const PREFIX = '[merge-memory]';
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Most common metadata.type among the sources (first wins a tie): the merged fact keeps
// the kind its sources were.
function mergedType(sources) {
  const counts = new Map();
  for (const { content } of sources) {
    const t = content.match(/^metadata:\s*\r?\n(?:\s+.*\r?\n)*?\s+type:\s*(\w+)/m)?.[1] || 'project';
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

export function mergeContent(name, description, sources) {
  const desc = description || `${sources.length} entries merged`;
  let out = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n`
    + formatRefs({ merged_from: sources.map(s => s.path) })
    + `metadata:\n  type: ${mergedType(sources)}\n---\n`;
  for (const { path, content } of sources) {
    const { fields, body } = parseFrontmatter(content);
    const d = fields.description ? `_${fields.description}_\n\n` : '';
    out += `\n## From ${path}\n\n${d}${body.trim()}\n`;
  }
  for (const { path, content } of sources) {
    const missing = parseFrontmatter(content).body.split(/\r?\n/).filter(l => l.trim() && !out.includes(l));
    if (missing.length) throw new Error(`${path}: ${missing.length} line(s) would be lost`);
  }
  return out;
}

function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const name = arg('--name');
  const from = (arg('--from') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!name || !NAME_RE.test(name) || from.length < 1) {
    console.error(`${PREFIX} usage: --name <kebab-slug> --from <a.md,b.md> [--description <text>] [--dry-run]`);
    process.exit(1);
  }
  const scope = findMemoryScope();
  const memDir = join(scope, '.claude', 'memory');
  const known = new Set(listEntries(scope).map(e => e.path));
  const sources = from.map(p => {
    if (!known.has(p)) { console.error(`${PREFIX} not an entry: ${p}`); process.exit(1); }
    return { path: p, content: readFileSync(join(memDir, p), 'utf8') };
  });
  const merged = mergeContent(name, arg('--description'), sources);
  if (argv.includes('--dry-run')) { process.stdout.write(merged); return; }
  const rel = `${dateToPath()}/${name}.md`;
  const file = join(memDir, rel);
  if (!writeOnce(file, merged)) { console.error(`${PREFIX} ${rel} exists — an entry is never edited; pick another --name`); process.exit(1); }
  rebuildIndex(scope);
  console.log(`${PREFIX} ${rel} folds ${from.length} entr${from.length === 1 ? 'y' : 'ies'}; sources kept on disk, hidden`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/merge-memory.js')) main(process.argv.slice(2));
