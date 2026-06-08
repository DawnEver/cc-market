#!/usr/bin/env node
// task-engine.js — generic task management engine (owned by rem)
// Takes pre-enriched task objects via --findings <json-file>.
// Generates tasks.md, archives resolved, updates MEMORY.md.
// Status comes from finding.status (set by caller, e.g. post-review.js).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { memoryDir, indexFile, todayISO, DAY_MS } from '../lib.mjs';

// ── Paths ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TASKS_DIR = join(memoryDir, 'tasks');
const ARCHIVE_DIR = join(TASKS_DIR, 'archive');
const TASKS_FILE = join(TASKS_DIR, 'tasks.md');
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

// ── Task file parsing ──

const TASK_LINE_RE = /^-\s+\[([ x])\]\s+(\S+)\s+\[(\w+)\]\s+(.+?)\s+\((\d{4}-?\d{2}-?\d{2}|undefined)\).*$/;

function parseExistingTasks(content) {
  const existing = new Map();
  if (!content) return existing;
  let currentModule = 'unknown';
  for (const line of content.split('\n')) {
    if (line.startsWith('### ')) { currentModule = line.slice(4).trim(); continue; }
    const m = line.match(TASK_LINE_RE);
    if (m) {
      const rawDate = m[5];
      existing.set(m[2], {
        id: m[2],
        checked: m[1] === 'x',
        severity: m[3],
        summary: m[4].trim(),
        discovered: rawDate === 'undefined' ? undefined
          : rawDate.includes('-') ? rawDate
          : `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`,
        module: currentModule,
        trail: line.slice(line.lastIndexOf(`(${rawDate})`) + rawDate.length + 1).trim(),
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

function mergePreserved(findings, preserved) {
  const taskIds = new Set(findings.map(f => f.id));
  for (const [id, entry] of preserved) {
    if (!taskIds.has(id) && !entry.checked) {
      findings.push({
        id: entry.id,
        severity: entry.severity,
        file: '',
        summary: entry.summary,
        category: 'Bug',
        module: entry.module || 'unknown',
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
  const likely = !(f.status || '').toLowerCase().startsWith('fix') && checkFileModified(f, today) ? ' ⚠ likely-resolved' : '';
  const ref = f.memoryRef ? `\n      ref: ../${f.memoryRef}` : '';
  return `- [ ] ${f.id} [${f.severity}] ${f.summary} (${f.discovered})${stale}${likely}${ref}`;
}

function taskFrontmatter(openCount, today) {
  return [
    '---',
    `name: active-tasks`,
    `description: Active task list — ${openCount} open. Managed by rem/scripts/task-engine.js. Load on demand via MEMORY.md.`,
    'metadata:',
    '  type: project',
    `created: ${today}`,
    `accessed: ${today}`,
    'tier: short',
    '---',
    '',
  ].join('\n');
}

function generateSmall(findings, preserved, today) {
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => (f.status || '').toLowerCase() !== 'fixed');
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

function generateMedium(findings, preserved, today) {
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => (f.status || '').toLowerCase() !== 'fixed');
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

function generateLarge(findings, preserved, today) {
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => (f.status || '').toLowerCase() !== 'fixed');
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
  const resolved = findings.filter(f => ['fixed', 'resolved'].includes((f.status || '').toLowerCase()));
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
    console.log(`[task-engine] Archived ${archivedCount} items → archive/${month}.md`);
  }
}

// ── MEMORY.md integration ──

const TASK_SECTION_HEADER = '## Tasks (progressive disclosure)';
const TASK_SECTION_DESC = '<!-- Task list managed by rem/scripts/task-engine.js. Load on demand via the index entries below. Completed tasks are archived to memory/tasks/archive/ and evicted after 90d. -->';

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

  // --add → append a manual task
  if (args.includes('--add')) {
    const summaryIdx = args.indexOf('--summary');
    if (summaryIdx < 0) { console.error('[task-engine] --add requires --summary "task description"'); process.exit(1); }
    const summary = args[summaryIdx + 1];
    if (!summary) { console.error('[task-engine] --summary value is required'); process.exit(1); }

    const severityIdx = args.indexOf('--severity');
    const severity = (severityIdx >= 0 ? args[severityIdx + 1] : 'MEDIUM') || 'MEDIUM';
    const moduleIdx = args.indexOf('--module');
    const module = (moduleIdx >= 0 ? args[moduleIdx + 1] : 'manual') || 'manual';
    const catIdx = args.indexOf('--category');
    const category = (catIdx >= 0 ? args[catIdx + 1] : 'Bug') || 'Bug';

    // Generate sequence number
    let seq = 1;
    if (existsSync(TASKS_FILE)) {
      const existing = readFileSync(TASKS_FILE, 'utf8');
      const manualIds = [...existing.matchAll(/\bMANUAL-\d{8}-(\d{3})\b/g)];
      if (manualIds.length > 0) {
        seq = Math.max(...manualIds.map(m => parseInt(m[1], 10))) + 1;
      }
    }
    const id = `MANUAL-${today.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;

    // Append to tasks.md
    let content = '';
    if (existsSync(TASKS_FILE)) {
      content = readFileSync(TASKS_FILE, 'utf8');
      if (!content.endsWith('\n')) content += '\n';
    } else {
      content = taskFrontmatter(0, today) + '\n# Active Tasks\n> 0 open · last sync: ${today}\n\n';
    }
    content += `- [ ] ${id} [${severity}] ${summary} (${today})\n      module: ${module} · category: ${category}\n`;
    writeFileSync(TASKS_FILE, content, 'utf8');
    console.log(`[task-engine] Added: ${id} [${severity}] ${summary}`);
    process.exit(0);
  }

  // --check → verify tasks.md is up to date
  if (args.includes('--check')) {
    if (!existsSync(TASKS_FILE)) {
      console.log('[task-engine] No task file found — needs sync');
      process.exit(1);
    }
    const existing = readFileSync(TASKS_FILE, 'utf8');
    if (!existing.includes(`last sync: ${today}`)) {
      console.log('[task-engine] Task file stale — needs sync');
      process.exit(1);
    }
    console.log('[task-engine] Task file up to date');
    process.exit(0);
  }

  // --report → print summary
  if (args.includes('--report')) {
    if (!existsSync(TASKS_FILE)) {
      console.log('[task-engine] No task file found. Run sync first.');
      process.exit(0);
    }
    const content = readFileSync(TASKS_FILE, 'utf8');
    const existing = parseExistingTasks(content);
    const open = [...existing.values()].filter(e => !e.checked);
    const done = [...existing.values()].filter(e => e.checked);
    console.log(`[task-engine] ${open.length} open, ${done.length} resolved`);
    for (const f of open) {
      console.log(`  ${f.id} [${f.severity}] ${f.summary} (${f.discovered})`);
    }
    process.exit(0);
  }

  // --findings <json-file> → full sync
  const findingsIdx = args.indexOf('--findings');
  if (findingsIdx < 0) {
    console.error('[task-engine] Expected --findings <json-file>, --check, or --report');
    process.exit(1);
  }

  const findingsFile = args[findingsIdx + 1];
  if (!findingsFile || !existsSync(findingsFile)) {
    console.error(`[task-engine] Findings file not found: ${findingsFile}`);
    process.exit(1);
  }

  let allFindings;
  try {
    allFindings = JSON.parse(readFileSync(findingsFile, 'utf8'));
  } catch (e) {
    console.error(`[task-engine] Failed to parse findings JSON: ${e.message}`);
    process.exit(1);
  }

  // Load existing task file to preserve manual entries
  let preserved = new Map();
  if (existsSync(TASKS_FILE)) {
    preserved = parseExistingTasks(readFileSync(TASKS_FILE, 'utf8'));
  }

  // Archive resolved findings
  archiveResolved(allFindings, today);

  // Recompute open after resolution propagation
  const openFindings = allFindings.filter(f => (f.status || '').toLowerCase() !== 'fixed');
  const scale = detectScale(openFindings.length);

  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

  if (scale === 'large') {
    const files = generateLarge(openFindings, preserved, today);
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
    console.log(`[task-engine] Large scale — ${Object.keys(files).length} files → memory/tasks/`);
  } else {
    const content = scale === 'small'
      ? generateSmall(openFindings, preserved, today)
      : generateMedium(openFindings, preserved, today);
    writeFileSync(TASKS_FILE, content, 'utf8');
    updateMemoryIndex(scale, openFindings, {}, today);
    console.log(`[task-engine] ${openFindings.length} findings → memory/tasks/tasks.md (${scale} tier)`);
  }

  // Print summary
  const stale = openFindings.filter(f => isStale(f, today)).length;
  const likely = openFindings.filter(f => !f.status.startsWith('fix') && checkFileModified(f, today)).length;
  if (stale > 0) console.log(`[task-engine] ⚠ ${stale} stale (>${STALE_DAYS}d)`);
  if (likely > 0) console.log(`[task-engine] ⚠ ${likely} likely-resolved (file modified since discovery)`);
}

main();
