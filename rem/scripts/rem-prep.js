#!/usr/bin/env node
// REM preparation script — runs before /rem skill, does all mechanical work:
//   1. Show recent prune events from unified state
//   2. Scan transcript for .claude/memory/ file reads → batch bump accessed
//   3. For touched files, check git log commit frequency → suggest promotions
//   4. Check if compact is needed
//
// Usage: node rem-prep.js [--transcript <path>] [--promote]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  scopeMemoryDir, scopeIndexFile, findAllScopes, loadState,
  todayISO, bumpAccessed, getTier, getAccessCount, setField, MAX_ENTRIES,
  resolveMemoryPath, isInsideMemoryDir, updateIndexAccessed,
} from '../lib.mjs';

const args = process.argv.slice(2);
const transcriptIdx = args.indexOf('--transcript');
const transcriptPath = transcriptIdx >= 0 ? args[transcriptIdx + 1] : null;
const autoPromote = args.includes('--promote');
const today = todayISO();

// ── 1. Event log (from unified state) ──
console.log('─── Recent prune events ───');
const state = loadState();
const events = state.prune.events || [];
if (events.length === 0) {
  console.log('  (no events)');
} else {
  const recent = events.slice(-20);
  for (const ev of recent) {
    const ts = ev.ts?.slice(0, 19) || '?';
    console.log(`  [${ts}] ${ev.type}: ${ev.path}${ev.reason ? ` (${ev.reason})` : ''}`);
  }
}

// ── 2. Scan transcript for memory file access (reads & edits) ──
console.log('\n─── Memory files accessed ───');
const touchedFiles = new Set();

if (transcriptPath && existsSync(transcriptPath)) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(block?.name)) {
          const fp = block?.input?.file_path || '';
          const rel = fp.replace(/\\/g, '/');
          const memIdx = rel.indexOf('.claude/memory/');
          if (memIdx >= 0) {
            touchedFiles.add(rel.slice(memIdx + '.claude/memory/'.length));
          }
        }
      }
    }
  } catch { /* transcript parse error — skip */ }
}

if (touchedFiles.size === 0) {
  console.log('  (no memory files read this session)');
} else {
  const scopes = findAllScopes();
  for (const f of touchedFiles) {
    // Search all scopes for the file
    let found = false;
    for (const scope of scopes) {
      const memFile = join(scope, '.claude', 'memory', f);
      if (!existsSync(memFile)) continue;
      found = true;
      let content = readFileSync(memFile, 'utf8');
      content = bumpAccessed(content, today);
      writeFileSync(memFile, content, 'utf8');
      // Update that scope's index
      const idxFile = join(scope, '.claude', 'rules', 'MEMORY.md');
      if (existsSync(idxFile)) {
        const origIdx = readFileSync(idxFile, 'utf8');
        const newIdx = updateIndexAccessed(origIdx, f, today);
        if (newIdx !== null && newIdx !== origIdx) {
          writeFileSync(idxFile, newIdx, 'utf8');
        }
      }
      console.log(`  ✓ ${f} → accessed: ${today} (${scope === process.env.CLAUDE_PROJECT_DIR ? 'global' : 'scoped'})`);
      break;
    }
    if (!found) console.log(`  ? ${f} (not found in any scope)`);
  }
}

// ── 2b. Scan transcript for SR-ID references → touch finding memory files ──
console.log('\n─── Sharp-review findings referenced ───');
const touchedSRIds = new Set();

if (transcriptPath && existsSync(transcriptPath)) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    const SR_RE = /SR-(\d{8})-(\d{3})/g;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const text = JSON.stringify(entry);
      let m;
      while ((m = SR_RE.exec(text)) !== null) {
        const dateStr = m[1]; // YYYYMMDD
        const dateDir = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
        touchedSRIds.add({ id: m[0], dateDir, seq: m[3] });
      }
    }
  } catch { /* transcript parse error — skip */ }
}

if (touchedSRIds.size === 0) {
  console.log('  (no SR-ID references this session)');
} else {
  const scopes = findAllScopes();
  for (const { id, dateDir } of touchedSRIds) {
    const filename = `${id}.md`;
    let found = false;

    for (const scope of scopes) {
      const scopeMem = join(scope, '.claude', 'memory');
      const expectedPath = join(scopeMem, dateDir, filename);
      if (existsSync(expectedPath)) {
        found = true;
      } else {
        // Fallback: search all date directories in this scope
        try {
          for (const dirEntry of readdirSync(scopeMem, { withFileTypes: true })) {
            if (!dirEntry.isDirectory() || dirEntry.name.startsWith('.') || dirEntry.name === 'tasks') continue;
            if (existsSync(join(scopeMem, dirEntry.name, filename))) { found = true; break; }
          }
        } catch {}
      }

      if (found) {
        const relPath = `${dateDir}/${filename}`;
        const memFile = join(scopeMem, relPath);
        if (existsSync(memFile)) {
          let content = readFileSync(memFile, 'utf8');
          content = bumpAccessed(content, today);
          writeFileSync(memFile, content, 'utf8');
          const idxFile = join(scope, '.claude', 'rules', 'MEMORY.md');
          if (existsSync(idxFile)) {
            const origIdx = readFileSync(idxFile, 'utf8');
            const newIdx = updateIndexAccessed(origIdx, relPath, today);
            if (newIdx !== null && newIdx !== origIdx) {
              writeFileSync(idxFile, newIdx, 'utf8');
            }
          }
          console.log(`  ✓ ${id} → accessed: ${today}`);
        }
        break;
      }
    }
    if (!found) console.log(`  ? ${id} (no memory entry yet — will be created on next sync)`);
  }
}

// ── 3. Promotion suggestions ──
console.log('\n─── Promotion candidates ──');
let promoted = 0;
const allScopes = findAllScopes();

function findInScopes(relPath) {
  for (const scope of allScopes) {
    const p = join(scope, '.claude', 'memory', relPath);
    if (existsSync(p)) return { file: p, scope };
  }
  return null;
}

for (const f of touchedFiles) {
  const found = findInScopes(f);
  if (!found) continue;
  const { file: memFile } = found;

  const content = readFileSync(memFile, 'utf8');
  const currentTier = getTier(content);
  if (currentTier === 'long') continue;

  const accessCount = getAccessCount(content);
  if (accessCount >= 3) {
    console.log(`  ↑ ${f} (accessed ${accessCount}x, currently ${currentTier})`);
    if (autoPromote) {
      let c = content;
      c = setField(c, 'accessed', today);
      c = setField(c, 'tier', 'long');
      writeFileSync(memFile, c, 'utf8');
      promoted++;
    }
  }
}

// Also check SR-ID memory files for promotion
if (touchedSRIds.size > 0) {
  for (const { id, dateDir } of touchedSRIds) {
    const relPath = `${dateDir}/${id}.md`;
    const found = findInScopes(relPath);
    if (!found) continue;
    const { file: memFile } = found;
    const content = readFileSync(memFile, 'utf8');
    const currentTier = getTier(content);
    if (currentTier === 'long') continue;

    const accessCount = getAccessCount(content);
    if (accessCount >= 3) {
      console.log(`  ↑ ${id} → promotion candidate (accessed ${accessCount}x, currently ${currentTier})`);
      if (autoPromote) {
        let c = content;
        c = setField(c, 'accessed', today);
        c = setField(c, 'tier', 'long');
        writeFileSync(memFile, c, 'utf8');
        promoted++;
      }
    }
  }
}

if (promoted > 0) {
  console.log(`  → auto-promoted ${promoted} file(s) to long-term`);
} else if (touchedFiles.size > 0 || touchedSRIds.size > 0) {
  console.log('  (no promotion candidates — run with --promote to auto-upgrade)');
}

// ── 4. Compact check ──
console.log('\n─── Compact status ──');
if (existsSync(scopeIndexFile)) {
  const entries = readFileSync(scopeIndexFile, 'utf8').split('\n').filter(l => /^-\s+\[/.test(l));
  if (entries.length >= MAX_ENTRIES) {
    console.log(`  ⚠ ${entries.length} entries — compact recommended`);
  } else {
    console.log(`  ✓ ${entries.length} entries (<${MAX_ENTRIES}) — no compact needed`);
  }
} else {
  console.log('  (no MEMORY.md yet)');
}

console.log('\n[rem-prep] done');
