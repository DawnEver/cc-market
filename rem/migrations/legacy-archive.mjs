// legacy-archive.mjs — fold non-conforming task archives into .claude/tasks/archive/YYYY/MM/DD.md
//
// Canonical format: resolved findings live in .claude/tasks/archive/YYYY/MM/DD.md, one file
// per resolution day, each entry a two-line block:
//   - [x] SR-... [SEVERITY] summary
//         → FIXED YYYY-MM-DD: note
//
// Any .md file containing such blocks but not stored at that canonical path (legacy
// .claude/memory/tasks/**, monthly archive/YYYY/MM.md or archive/YYYY-MM.md rollups, etc.)
// has its blocks extracted and merged into the canonical per-day files, deduped by ID.
// Non-entry content (headers, unrelated notes) is left in place; files left empty after
// extraction are removed.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join, relative, sep } from 'path';

const ENTRY_FIRST_LINE_RE = /^- \[x\] (\S+)/;
const FIXED_DATE_RE = /→ FIXED (\d{4}-\d{2}-\d{2}):/;
const CANONICAL_RE = /^\d{4}\/\d{2}\/\d{2}\.md$/;

function toPosix(p) {
  return p.split(sep).join('/');
}

// Split file body into blocks separated by blank lines, classify each as a
// resolved-task entry (has `- [x] ID` + `→ FIXED date:`) or "other" content.
function splitBlocks(content) {
  const blocks = content.split(/\n{2,}/);
  const entries = [];
  const other = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = block.split('\n');
    const idMatch = lines[0].match(ENTRY_FIRST_LINE_RE);
    const dateLine = lines.find(l => FIXED_DATE_RE.test(l));
    if (idMatch && dateLine) {
      entries.push({ id: idMatch[1], date: dateLine.match(FIXED_DATE_RE)[1], text: trimmed });
    } else {
      other.push(trimmed);
    }
  }
  return { entries, other };
}

function appendEntries(archiveDir, date, entries) {
  const dayPath = date.replace(/-/g, '/'); // 2026-06-09 -> 2026/06/09
  const dir = join(archiveDir, ...dayPath.split('/').slice(0, 2));
  const file = join(archiveDir, `${dayPath}.md`);
  mkdirSync(dir, { recursive: true });

  let existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const fresh = entries.filter(e => !existing.includes(e.id));
  if (!fresh.length) return 0;

  const block = fresh.map(e => e.text).join('\n\n');
  if (!existing) {
    writeFileSync(file, `# Resolved Tasks — ${date}\n\n${block}\n`, 'utf8');
  } else {
    writeFileSync(file, `${existing.trimEnd()}\n\n${block}\n`, 'utf8');
  }
  return fresh.length;
}

// Files that are candidates for migration: every .md file under the legacy
// .claude/memory/tasks/ tree, plus any .md file directly under
// .claude/tasks/archive/ that isn't already at the canonical YYYY/MM/DD.md path.
function collectCandidates(projectRoot) {
  const candidates = [];
  const archiveDir = join(projectRoot, '.claude', 'tasks', 'archive');
  const legacyDir = join(projectRoot, '.claude', 'memory', 'tasks');

  if (existsSync(archiveDir)) {
    walk(archiveDir, file => {
      const rel = toPosix(relative(archiveDir, file));
      if (!CANONICAL_RE.test(rel)) candidates.push(file);
    });
  }
  if (existsSync(legacyDir)) {
    walk(legacyDir, file => candidates.push(file));
  }
  return candidates;
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile() && entry.name.endsWith('.md')) onFile(full);
  }
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

export function migrateLegacyArchives(projectRoot) {
  const summary = [];
  let changed = false;
  const archiveDir = join(projectRoot, '.claude', 'tasks', 'archive');
  const legacyDir = join(projectRoot, '.claude', 'memory', 'tasks');

  for (const file of collectCandidates(projectRoot)) {
    const content = readFileSync(file, 'utf8');
    const { entries, other } = splitBlocks(content);
    if (!entries.length) continue;

    let migratedCount = 0;
    const byDate = new Map();
    for (const e of entries) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    for (const [date, ents] of byDate) {
      migratedCount += appendEntries(archiveDir, date, ents);
    }

    const remaining = other.filter(b => !/^# Resolved Tasks/.test(b));
    if (remaining.length) {
      writeFileSync(file, remaining.join('\n\n') + '\n', 'utf8');
    } else {
      rmSync(file);
    }

    changed = true;
    const relFile = toPosix(relative(projectRoot, file));
    summary.push(`migrated ${migratedCount} resolved task(s) from ${relFile} into .claude/tasks/archive/YYYY/MM/DD.md`);
  }

  if (existsSync(legacyDir) && isEmptyDirTree(legacyDir)) {
    rmSync(legacyDir, { recursive: true });
    changed = true;
    summary.push('removed empty legacy .claude/memory/tasks/ (superseded by .claude/tasks/archive/)');
  }

  return { changed, summary };
}
