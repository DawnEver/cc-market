#!/usr/bin/env node
// Crystallize: distill memory entries into a rule; the entries stay on disk, hidden.
//
//   node crystallize.js --check      → exit 0 when live entries reach CRYSTALLIZE_ADVISORY
//   node crystallize.js --propose    → JSON of every live entry, oldest first, for review
//   node crystallize.js --validate   → list .claude/rules/rem/ rules
//   node crystallize.js --execute --rule <file.md> --distilled <a.md,b.md,...>
//        → after the model wrote .claude/rules/rem/<file.md>: record a dated
//          `crystallized-into-<rule>` entry naming the distilled entries in
//          `supersedes:` and pointing at the rule, which hides them from recall and the index.
//
// The rule is the single source of the distilled fact; the ledger entry is the
// provenance that hides the originals. No entry is ever deleted.

import { SR_ID_RE } from '../shared/lib.mjs';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import {
  remRulesDir, scopeMemoryDir as memoryDir, scopeRoot, CRYSTALLIZE_ADVISORY,
  listEntries, hiddenEntries, rebuildIndex, dateToPath, formatRefs,
} from './lib.mjs';

const args = process.argv.slice(2);
const mode = args[0] || '--check';
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

function liveEntries() {
  const entries = listEntries(scopeRoot);
  const hidden = hiddenEntries(entries);
  return entries.filter(e => !hidden.has(e.path));
}

export function ledgerEntry(rule, paths, date) {
  const stem = basename(rule, '.md');
  return {
    relPath: `${dateToPath(date)}/crystallized-into-${stem}.md`,
    content: `---\nname: crystallized-into-${stem}\n`
      + `description: ${paths.length} entries distilled into .claude/rules/rem/${rule}\n`
      + formatRefs({ supersedes: paths })
      + `metadata:\n  type: project\n---\n\n`
      + `Distilled into \`.claude/rules/rem/${rule}\`, which is now the source of these facts.\n`
      + `The originals stay at the paths listed in \`supersedes\`.\n`,
  };
}

if (mode === '--check') {
  const n = liveEntries().length;
  const needed = n >= CRYSTALLIZE_ADVISORY;
  console.log(`[crystallize] ${n} live entries (${needed ? '≥' : '<'}${CRYSTALLIZE_ADVISORY}) — ${needed ? 'crystallize needed' : 'not needed'}`);
  process.exit(needed ? 0 : 1);
}

if (mode === '--propose') {
  const entries = liveEntries().reverse()
    .map(({ path, name, date, type, description }) => ({ path, name, date, type, description }));
  console.log(JSON.stringify({ entryCount: entries.length, advisory: CRYSTALLIZE_ADVISORY, entries }, null, 2));
  process.exit(0);
}

if (mode === '--validate') {
  const rules = existsSync(remRulesDir)
    ? readdirSync(remRulesDir).filter(f => f.endsWith('.md')) : [];
  if (!rules.length) { console.log('[crystallize] .claude/rules/rem/ has no rules'); process.exit(0); }
  console.log(`[crystallize] rem/ contains ${rules.length} rule(s):`);
  for (const f of rules) {
    const content = readFileSync(join(remRulesDir, f), 'utf8');
    console.log(`  ${content.trim() ? '✓' : '!'} ${f} (${content.length}B)${content.trim() ? '' : ' — empty file'}`);
  }
  process.exit(0);
}

if (mode === '--execute') {
  const rule = arg('--rule');
  const paths = (arg('--distilled') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!rule || !paths.length) {
    console.error('[crystallize] usage: --execute --rule <file.md> --distilled <a.md,b.md,...>');
    process.exit(1);
  }
  const ruleFile = join(remRulesDir, basename(rule));
  if (!existsSync(ruleFile) || !readFileSync(ruleFile, 'utf8').trim()) {
    console.error(`[crystallize] ${ruleFile} missing or empty — write the rule first`);
    process.exit(1);
  }
  const live = new Set(liveEntries().map(e => e.path));
  const unknown = paths.filter(p => !live.has(p));
  if (unknown.length) {
    console.error(`[crystallize] not live entries: ${unknown.join(', ')}`);
    process.exit(1);
  }
  const srIds = new Set();
  for (const p of paths) for (const m of readFileSync(join(memoryDir, p), 'utf8').matchAll(SR_ID_RE)) srIds.add(m[0]);

  const { relPath, content } = ledgerEntry(basename(rule), paths);
  const file = join(memoryDir, relPath);
  if (existsSync(file)) {
    console.error(`[crystallize] ${relPath} exists — one crystallize per rule per day`);
    process.exit(1);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  rebuildIndex(scopeRoot);
  console.log(`[crystallize] ${relPath} records the rule; ${paths.length} entr${paths.length === 1 ? 'y' : 'ies'} hidden, kept on disk`);
  if (srIds.size) console.log(`[crystallize] SR findings now in the rule: ${[...srIds].join(', ')}`);
  process.exit(0);
}

console.log('Usage: node crystallize.js [--check|--propose|--validate|--execute --rule <f> --distilled <paths>]');
process.exit(1);
