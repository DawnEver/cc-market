#!/usr/bin/env node
// sync-tasks.js — task management engine (owned by rem)
// Takes finding objects via --findings <json-file>, manages tasks.md, archive, MEMORY.md.
// Sharp-review calls this via its thin wrapper; users call it via /tasks skill.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  memoryDir, indexFile, todayISO, DAY_MS,
  inferModule, inferCategory,
  collectMemoryRefs, crossReferenceFindings, writeBackMemoryRefs, findingToMemoryEntry,
} from '../lib.mjs';

// ── Paths ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TASKS_DIR = join(memoryDir, 'tasks');
const ARCHIVE_DIR = join(TASKS_DIR, 'archive');
const TASKS_FILE = join(TASKS_DIR, 'tasks.md');
const RESOLVED_FILE = join(TASKS_DIR, 'resolved.txt');
const OLD_RESOLVED_FILE = join(ROOT, '.claude', 'sharp-review', 'resolved.txt');
const STALE_DAYS = 90;

// ── Helpers ──

function isStale(finding, today) {
  if (!finding.discovered) return false;
  const discovered = new Date(finding.discovered).getTime();
  return (new Date(today).getTime() - discovered) > STALE_DAYS * DAY_MS;
}

function checkFileModified(finding, today) {
  if (!finding.file) return false;
  try {
    const absPath = join(ROOT, finding.file);
    if (!existsSync(absPath)) return true;
    const mtime = statSync(absPath).mtimeMs;
    const discovered = new Date(finding.discovered).getTime();
    const todayStart = new Date(today).getTime();
    if (discovered >= todayStart) return false;
    return mtime > discovered;
  } catch { return false; }
}

function detectScale(openCount) {
  if (openCount < 10) return 'small';
  if (openCount < 50) return 'medium';
  return 'large';
}

// ── Resolved IDs ──

function loadResolvedIds() {
  // Migrate from old location on first run
  if (!existsSync(RESOLVED_FILE) && existsSync(OLD_RESOLVED_FILE)) {
    const old = new Set(readFileSync(OLD_RESOLVED_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
    if (old.size > 0) {
      if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
      writeFileSync(RESOLVED_FILE, [...old].sort().join('\n') + '\n', 'utf8');
      return old;
    }
  }
  if (!existsSync(RESOLVED_FILE)) return new Set();
  return new Set(readFileSync(RESOLVED_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function saveResolvedIds(ids) {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(RESOLVED_FILE, [...ids].sort().join('\n') + '\n', 'utf8');
}

// ── Task file parsing ──

const TASK_LINE_RE = /^-\s+\[([ x])\]\s+(SR-\d{8}-\d{3})\s+\[(\w+)\]\s+(.+?)\s+\((\d{4}-?\d{2}-?\d{2})\).*$/;

function parseExistingTasks(content) {
  const existing = new Map();
  if (!content) return existing;
  for (const line of content.split('\n')) {
    const m = line.match(TASK_LINE_RE);
    if (m) {
      existing.set(m[2], {
        id: m[2],
        checked: m[1] === 'x',
        severity: m[3],
        summary: m[4].trim(),
        discovered: m[5].includes('-') ? m[5] : `${m[5].slice(0,4)}-${m[5].slice(4,6)}-${m[5].slice(6,8)}`,
        trail: line.slice(line.lastIndexOf(`(${m[5]})`) + m[5].length + 1).trim(),
      });
    }
  }
  return existing;
}

// ── Task file generation ──

function groupByModule(findings) {
  const groups = new Map();
  for (const f of findings) {
    const mod = f.module || 'unknown';
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(f);
  }
  return groups;
}

function groupByCategory(findings) {
  const groups = { Feature: [], Bug: [], Performance: [] };
  for (const f of findings) {
    const cat = f.category || 'Bug';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

function mergePreserved(findings, preserved, resolvedIds = new Set()) {
  const srIds = new Set(findings.map(f => f.id));
  for (const [id, entry] of preserved) {
    if (!srIds.has(id) && !entry.checked && !resolvedIds.has(id)) {
      findings.push({
        id: entry.id,
        severity: entry.severity,
        file: '',
        summary: entry.summary,
        category: inferCategory(entry.summary),
        module: inferModule(''),
        status: 'open',
        discovered: entry.discovered,
        suggestion: '',
        detail: '',
        _preserved: true,
      });
    }
  }
  return findings;
}

function formatFindingLine(f, today) {
  const stale = isStale(f, today) ? ' ⚠ stale' : '';
  const likely = !f.status.startsWith('fix') && checkFileModified(f, today) ? ' ⚠ likely-resolved' : '';
  const ref = f.memoryRef ? `\n      ref: ../${f.memoryRef}` : '';
  return `- [ ] ${f.id} [${f.severity}] ${f.summary} (${f.discovered})${stale}${likely}${ref}`;
}

function taskFrontmatter(openCount, today) {
  return [
    '---',
    `name: active-tasks`,
    `description: Active task list — ${openCount} open. Managed by rem/scripts/sync-tasks.js. Load on demand via MEMORY.md.`,
    'metadata:',
    '  type: project',
    `created: ${today}`,
    `accessed: ${today}`,
    'tier: short',
    '---',
    '',
  ].join('\n');
}

function generateSmall(findings, preserved, resolvedIds, today) {
  const merged = mergePreserved([...findings], preserved, resolvedIds);
  const open = merged.filter(f => f.status !== 'fixed');
  const byMod = groupByModule(open);
  const lines = [];
  lines.push(taskFrontmatter(open.length, today));
  lines.push('# Active Tasks');
  lines.push(`> ${open.length} open · last sync: ${today}`);
  lines.push('');
  for (const [mod, items] of [...byMod].sort()) {
    if (items.length === 0) continue;
    lines.push(`## ${mod}`);
    for (const f of items) {
      lines.push(formatFindingLine(f, today));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function generateMedium(findings, preserved, resolvedIds, today) {
  const merged = mergePreserved([...findings], preserved, resolvedIds);
  const open = merged.filter(f => f.status !== 'fixed');
  const byCat = groupByCategory(open);
  const lines = [];
  lines.push(taskFrontmatter(open.length, today));
  lines.push('# Active Tasks');
  lines.push(`> ${open.length} open · last sync: ${today}`);
  lines.push('');

  for (const [cat, items] of Object.entries(byCat)) {
    if (items.length === 0) continue;
    const byMod = groupByModule(items);
    lines.push(`## ${cat} (${items.length})`);
    for (const [mod, modItems] of [...byMod].sort()) {
      lines.push(`### ${mod}`);
      for (const f of modItems) {
        lines.push(formatFindingLine(f, today));
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function generateLarge(findings, preserved, resolvedIds, today) {
  const merged = mergePreserved([...findings], preserved, resolvedIds);
  const open = merged.filter(f => f.status !== 'fixed');
  const byCat = groupByCategory(open);
  const files = {};

  for (const [cat, items] of Object.entries(byCat)) {
    if (items.length === 0) continue;
    const byMod = groupByModule(items);
    const catSlug = cat.toLowerCase();
    const lines = [];
    lines.push(`# ${cat} Tasks`);
    lines.push(`> ${items.length} open · last sync: ${today}`);
    lines.push('');
    for (const [mod, modItems] of [...byMod].sort()) {
      lines.push(`## ${mod}`);
      for (const f of modItems) {
        lines.push(formatFindingLine(f, today));
      }
      lines.push('');
    }
    files[`${catSlug}.md`] = lines.join('\n') + '\n';
  }
  return files;
}

// ── Archive ──

function archiveResolved(findings, today) {
  const resolved = findings.filter(f => f.status === 'fixed' || f.status === 'resolved');
  if (resolved.length === 0) return;

  const byMonth = new Map();
  for (const f of resolved) {
    const month = (f.resolvedDate || f.discovered || today).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(f);
  }

  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

  for (const [month, items] of byMonth) {
    const archiveFile = join(ARCHIVE_DIR, `${month}.md`);
    let existing = '';
    if (existsSync(archiveFile)) {
      existing = readFileSync(archiveFile, 'utf8');
    }

    const newLines = [];
    for (const f of items) {
      if (existing.includes(f.id)) continue;
      newLines.push(`- [x] ${f.id} [${f.severity}] ${f.summary}`);
      newLines.push(`      → FIXED ${today}: ${f.resolutionNote || 'marked resolved'}`);
      newLines.push('');
    }

    if (newLines.length === 0) continue;

    if (!existing) {
      const header = `# Resolved Tasks — ${month}\n\n`;
      writeFileSync(archiveFile, header + newLines.join('\n') + '\n', 'utf8');
    } else {
      writeFileSync(archiveFile, existing.trimEnd() + '\n\n' + newLines.join('\n') + '\n', 'utf8');
    }
    const archivedCount = newLines.filter(l => l.startsWith('- [x]')).length;
    console.log(`[sync-tasks] Archived ${archivedCount} items → archive/${month}.md`);
  }
}

// ── MEMORY.md integration ──

const TASK_SECTION_HEADER = '## Tasks (progressive disclosure)';
const TASK_SECTION_DESC = '<!-- Task list managed by rem/scripts/sync-tasks.js. Load on demand via the index entries below. Completed tasks are archived to memory/tasks/archive/ and evicted after 90d. -->';

function updateMemoryIndex(scale, openFindings, files, today) {
  if (!existsSync(indexFile)) return;
  let content = readFileSync(indexFile, 'utf8');

  const taskEntries = [];
  if (scale === 'large') {
    const catNames = { bugs: 'Bugs', features: 'Features', perf: 'Performance' };
    for (const [catSlug] of Object.entries(files)) {
      const catFindings = openFindings.filter(f => (f.category || 'Bug').toLowerCase() === catSlug);
      taskEntries.push(`- [${today} ${catNames[catSlug] || catSlug}](../memory/tasks/${catSlug}.md) — ${catFindings.length} open`);
    }
  } else {
    taskEntries.push(`- [${today} Active Tasks](../memory/tasks/tasks.md) — ${openFindings.length} open`);
  }

  const taskSectionStart = content.indexOf(TASK_SECTION_HEADER);
  if (taskSectionStart >= 0) {
    const nextSection = content.indexOf('\n## ', taskSectionStart + TASK_SECTION_HEADER.length);
    if (nextSection >= 0) {
      content = content.slice(0, taskSectionStart - 1) + content.slice(nextSection);
    } else {
      content = content.slice(0, taskSectionStart - 1);
    }
  }

  content = content.replace(/^-\s+\[[\d-]+\s+(?:Active Tasks|Bugs|Features|Performance)\]\(\.\.\/memory\/tasks\/.+?\.md\)\s+—.+$/gm, '');
  content = content.replace(/\n{3,}/g, '\n\n');

  const section = [TASK_SECTION_HEADER, '', TASK_SECTION_DESC, '', ...taskEntries, ''].join('\n');

  const shortIdx = content.indexOf('\n## Short-term');
  if (shortIdx >= 0) {
    content = content.slice(0, shortIdx) + '\n' + section + content.slice(shortIdx);
  } else {
    content = content.trimEnd() + '\n\n' + section;
  }

  writeFileSync(indexFile, content, 'utf8');
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const today = todayISO();

  // --resolve SR-ID ... → persist IDs
  const resolveIdx = args.indexOf('--resolve');
  if (resolveIdx >= 0) {
    const ids = args.slice(resolveIdx + 1).filter(a => /^SR-\d{8}-\d{3}$/.test(a));
    if (ids.length === 0) { console.error('[sync-tasks] --resolve requires at least one SR-YYYYMMDD-NNN id'); process.exit(1); }
    const existing = loadResolvedIds();
    ids.forEach(id => existing.add(id));
    saveResolvedIds(existing);
    console.log(`[sync-tasks] resolved: ${ids.join(', ')} → ${RESOLVED_FILE}`);
    process.exit(0);
  }

  // --check → verify tasks.md is up to date
  const checkMode = args.includes('--check');
  if (checkMode) {
    if (!existsSync(TASKS_FILE)) {
      console.log('[sync-tasks] No task file found — needs sync');
      process.exit(1);
    }
    const existing = readFileSync(TASKS_FILE, 'utf8');
    if (!existing.includes(`last sync: ${today}`)) {
      console.log('[sync-tasks] Task file stale — needs sync');
      process.exit(1);
    }
    console.log('[sync-tasks] Task file up to date');
    process.exit(0);
  }

  // --report → print summary
  const reportMode = args.includes('--report');
  if (reportMode) {
    if (!existsSync(TASKS_FILE)) {
      console.log('[sync-tasks] No task file found. Run sync first.');
      process.exit(0);
    }
    const content = readFileSync(TASKS_FILE, 'utf8');
    const existing = parseExistingTasks(content);
    const open = [...existing.values()].filter(e => !e.checked);
    const done = [...existing.values()].filter(e => e.checked);
    console.log(`[sync-tasks] ${open.length} open, ${done.length} resolved`);
    for (const f of open) {
      console.log(`  ${f.id} [${f.severity}] ${f.summary} (${f.discovered})`);
    }
    process.exit(0);
  }

  // --findings <json-file> → full sync
  const findingsIdx = args.indexOf('--findings');
  if (findingsIdx < 0) {
    console.error('[sync-tasks] Expected --findings <json-file>, --resolve <ids>, --check, or --report');
    process.exit(1);
  }

  const findingsFile = args[findingsIdx + 1];
  if (!findingsFile || !existsSync(findingsFile)) {
    console.error(`[sync-tasks] Findings file not found: ${findingsFile}`);
    process.exit(1);
  }

  let allFindings;
  try {
    allFindings = JSON.parse(readFileSync(findingsFile, 'utf8'));
  } catch (e) {
    console.error(`[sync-tasks] Failed to parse findings JSON: ${e.message}`);
    process.exit(1);
  }

  // Enrich findings (fill missing module/category)
  for (const f of allFindings) {
    if (!f.module) f.module = inferModule(f.file);
    if (!f.category) f.category = inferCategory(f.summary, f.category);
  }

  // Memory cross-reference
  const { refs: memoryRefs, idIndex: memoryIdIndex } = collectMemoryRefs();
  crossReferenceFindings(allFindings, memoryRefs, memoryIdIndex);

  // Create individual memory entries for HIGH/MEDIUM findings
  let memCreated = 0;
  for (const f of allFindings) {
    if (!f.memoryRef) {
      const relPath = findingToMemoryEntry(f, memoryDir, today);
      if (relPath) { f.memoryRef = relPath; memCreated++; }
    }
  }
  if (memCreated > 0) console.log(`[sync-tasks] ${memCreated} findings → memory entries`);

  // Write SR-IDs back to matched/created memory files
  const wbCount = writeBackMemoryRefs(allFindings);
  if (wbCount > 0) console.log(`[sync-tasks] ${wbCount} SR-IDs written back to memory files`);

  // Load existing task file to preserve manual entries
  let preserved = new Map();
  if (existsSync(TASKS_FILE)) {
    preserved = parseExistingTasks(readFileSync(TASKS_FILE, 'utf8'));
  }

  // Apply persistent resolved IDs
  const resolvedIds = loadResolvedIds();

  // Propagate checked boxes from tasks.md → persist them
  const checkedIds = new Set([...preserved.values()].filter(e => e.checked).map(e => e.id));
  if (checkedIds.size > 0) {
    let newChecks = 0;
    for (const id of checkedIds) {
      if (!resolvedIds.has(id)) { resolvedIds.add(id); newChecks++; }
    }
    if (newChecks > 0) {
      saveResolvedIds(resolvedIds);
      console.log(`[sync-tasks] ${newChecks} checked task(s) persisted to resolved.txt`);
    }
  }

  // Mark all resolved IDs as fixed
  if (resolvedIds.size > 0) {
    let count = 0;
    for (const f of allFindings) {
      if (resolvedIds.has(f.id) && f.status !== 'fixed') { f.status = 'fixed'; count++; }
    }
    if (count > 0) console.log(`[sync-tasks] ${count} finding(s) marked fixed via resolved.txt`);
  }

  // Archive resolved findings
  archiveResolved(allFindings, today);

  // Recompute open after resolution propagation
  const openFindings = allFindings.filter(f => f.status !== 'fixed');
  const scale = detectScale(openFindings.length);

  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

  if (scale === 'large') {
    const files = generateLarge(openFindings, preserved, resolvedIds, today);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(TASKS_DIR, name), content, 'utf8');
    }
    const idxLines = ['# Task Directory', `> Scale: large (${allFindings.length} total, ${openFindings.length} open)`, ''];
    idxLines.push(`→ See sub-files for full lists:`);
    for (const [name] of Object.entries(files)) {
      const catName = name.replace('.md', '');
      const catFindings = openFindings.filter(f => (f.category || 'Bug').toLowerCase() === catName);
      idxLines.push(`- [${catName[0].toUpperCase() + catName.slice(1)}](${name}) (${catFindings.length} items)`);
    }
    writeFileSync(TASKS_FILE, idxLines.join('\n') + '\n', 'utf8');
    updateMemoryIndex(scale, openFindings, files, today);
    console.log(`[sync-tasks] Large scale — ${Object.keys(files).length} files → memory/tasks/`);
  } else {
    const content = scale === 'small'
      ? generateSmall(openFindings, preserved, resolvedIds, today)
      : generateMedium(openFindings, preserved, resolvedIds, today);
    writeFileSync(TASKS_FILE, content, 'utf8');
    updateMemoryIndex(scale, openFindings, {}, today);
    console.log(`[sync-tasks] ${openFindings.length} findings → memory/tasks/tasks.md (${scale} tier)`);
  }

  // Print summary
  const stale = openFindings.filter(f => isStale(f, today)).length;
  const likely = openFindings.filter(f => !f.status.startsWith('fix') && checkFileModified(f, today)).length;
  if (stale > 0) console.log(`[sync-tasks] ⚠ ${stale} stale (>${STALE_DAYS}d)`);
  if (likely > 0) console.log(`[sync-tasks] ⚠ ${likely} likely-resolved (file modified since discovery)`);
}

main();
