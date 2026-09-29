#!/usr/bin/env node
// Fold duplicate memory entries into ONE live entry — the only way an entry leaves the index
// by consolidation. Memory keeps everything: redundancy is removed by MERGING, never deleting.
//
//   node merge-memory.js --into <YYYY/MM/DD/live.md> --from <a.md,b.md,...> [--dry-run]
//
// For each source: its full body (every measurement, number and quote) is appended verbatim to
// the live entry under `## Merged from <path>`, the path is added to the live entry's
// `merged_from:` frontmatter list, and the source is tombstoned in the index as
// `dropped: merged→<live>`. The source FILE stays on disk untouched. The write is refused if any
// non-blank source line would be missing from the result.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { findMemoryScope, parseFrontmatter, dropFromIndex, rebuildIndex } from './lib.mjs';

const PREFIX = '[merge-memory]';

export function addMergedFrom(content, paths) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('live entry has no frontmatter');
  const lines = m[1].split(/\r?\n/);
  let at = lines.findIndex(l => /^merged_from:/.test(l));
  if (at < 0) { lines.push('merged_from:'); at = lines.length - 1; }
  let end = at + 1;
  while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
  const have = new Set(lines.slice(at + 1, end).map(l => l.replace(/^\s+-\s*/, '').trim()));
  lines.splice(end, 0, ...paths.filter(p => !have.has(p)).map(p => `  - ${p}`));
  return `---\n${lines.join('\n')}\n---${content.slice(m[0].length)}`;
}

export function mergeContent(live, sources) {
  let out = addMergedFrom(live, sources.map(s => s.path)).trimEnd();
  for (const { path, content } of sources) {
    const { fields, body } = parseFrontmatter(content);
    const desc = fields.description ? `_${fields.description}_\n\n` : '';
    out += `\n\n## Merged from ${path}\n\n${desc}${body.trim()}`;
  }
  out += '\n';
  for (const { path, content } of sources) {
    const missing = parseFrontmatter(content).body.split(/\r?\n/).filter(l => l.trim() && !out.includes(l));
    if (missing.length) throw new Error(`${path}: ${missing.length} line(s) would be lost`);
  }
  return out;
}

function main(argv) {
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const into = arg('--into');
  const from = (arg('--from') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!into || !from.length || from.includes(into)) {
    console.error(`${PREFIX} usage: --into <live.md> --from <a.md,b.md> [--dry-run] (a source may not be the live entry)`);
    process.exit(1);
  }
  const scope = findMemoryScope();
  const memDir = join(scope, '.claude', 'memory');
  const read = p => {
    const f = join(memDir, p);
    if (!existsSync(f)) { console.error(`${PREFIX} not found: ${p}`); process.exit(1); }
    return readFileSync(f, 'utf8');
  };
  const merged = mergeContent(read(into), from.map(p => ({ path: p, content: read(p) })));
  if (argv.includes('--dry-run')) { process.stdout.write(merged); return; }
  writeFileSync(join(memDir, into), merged, 'utf8');
  for (const p of from) dropFromIndex(scope, p, `merged→${into}`);
  rebuildIndex(scope);
  console.log(`${PREFIX} folded ${from.length} entr${from.length === 1 ? 'y' : 'ies'} into ${into}; sources kept on disk`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/merge-memory.js')) main(process.argv.slice(2));
