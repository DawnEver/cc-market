// task-lib.mjs — pure task management logic (owned by rem)
// Used by task-engine.js (CLI) and callable from post-review.js / tests.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { DAY_MS } from '../lib.mjs';

// ── Paths ──

export const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
export const TASKS_DIR = join(ROOT, '.claude', 'tasks');
export const ARCHIVE_DIR = join(TASKS_DIR, 'archive');
export const STALE_DAYS = 90;

// ── Helpers ──

export function isStale(finding, today) {
  if (!finding.discovered) return false;
  const discovered = new Date(finding.discovered).getTime();
  return (new Date(today).getTime() - discovered) > STALE_DAYS * DAY_MS;
}

export function checkFileModified(finding, today) {
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

export function detectScale(openCount) {
  if (openCount < 10) return 'small';
  if (openCount < 50) return 'medium';
  return 'large';
}

// ── Task file parsing ──

export const TASK_LINE_RE = /^-\s+\[([ x])\]\s+(\S+)\s+\[(\w+)\]\s+(.+?)\s+\((\d{4}-?\d{2}-?\d{2}|undefined)\).*$/;

export function parseExistingTasks(content) {
  const existing = new Map();
  if (!content) return existing;
  let currentModule = 'unknown';
  for (const line of content.split('\n')) {
    if (line.startsWith('### ')) { currentModule = line.slice(4).trim(); continue; }
    if (line.startsWith('## ')) { currentModule = line.slice(3).trim(); continue; }
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

export function groupByModule(findings) {
  const groups = new Map();
  for (const f of findings) {
    const mod = f.module || 'unknown';
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(f);
  }
  return groups;
}

export function groupByCategory(findings) {
  const groups = { Feature: [], Bug: [], Performance: [] };
  for (const f of findings) {
    const cat = f.category || 'Bug';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

// ── Sharp-review finding scanning ──

import { SR_FINDING_HDR_RE, SR_STATUS_RE } from '../shared/lib.mjs';

const SR_MODULE_RE = /^\s*-?\s*\*\*Module:\*\*\s*(.+)/m;

export function scanMemoryForFindings(memDir) {
  const findings = [];
  if (!existsSync(memDir)) return findings;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'tasks') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'sharp-review.md') {
        try {
          const content = readFileSync(full, 'utf8');
          const blocks = content.split(/\n(?=###\s+\[SR-)/);
          for (const block of blocks) {
            const hdr = block.match(SR_FINDING_HDR_RE);
            if (!hdr) continue;
            const statusMatch = block.match(SR_STATUS_RE);
            const status = statusMatch ? statusMatch[1].toLowerCase() : 'open';
            const moduleMatch = block.match(SR_MODULE_RE);
            findings.push({
              id: hdr[1],
              severity: hdr[2],
              file: hdr[3].trim(),
              summary: hdr[4].trim(),
              status,
              discovered: hdr[1].slice(3, 11).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
              category: 'Bug',
              module: moduleMatch ? moduleMatch[1].trim() : '',
              suggestion: '',
              detail: '',
            });
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(memDir);
  return findings;
}

export function scanManualTasks(memDir) {
  const tasks = [];
  if (!existsSync(memDir)) return tasks;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'manual.md') {
        try {
          const content = readFileSync(full, 'utf8');
          const parsed = parseExistingTasks(content);
          for (const [id, t] of parsed) {
            if (id.startsWith('MANUAL-')) {
              tasks.push({
                id,
                severity: t.severity,
                summary: t.summary,
                status: t.checked ? 'fixed' : 'open',
                discovered: t.discovered,
                module: t.module,
                category: 'Bug',
                file: '',
                suggestion: '',
                detail: '',
              });
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(memDir);
  return tasks;
}

// ── Archive ──

export function archiveResolved(findings, today, logPrefix = '[task-engine]') {
  const resolved = findings.filter(f => ['fixed', 'resolved'].includes((f.status || '').toLowerCase()));
  if (resolved.length === 0) return;

  const byDay = new Map();
  for (const f of resolved) {
    const day = f.resolvedDate || f.discovered || today;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(f);
  }

  for (const [day, items] of byDay) {
    const dayPath = day.replace(/-/g, '/'); // 2026-06-09 → 2026/06/09
    const dir = join(ARCHIVE_DIR, dayPath.split('/').slice(0, 2).join('/')); // 2026/06
    const archiveFile = join(ARCHIVE_DIR, `${dayPath}.md`); // 2026/06/09.md

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

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
      const header = `# Resolved Tasks — ${day}\n\n`;
      writeFileSync(archiveFile, header + newLines.join('\n') + '\n', 'utf8');
    } else {
      writeFileSync(archiveFile, existing.trimEnd() + '\n\n' + newLines.join('\n') + '\n', 'utf8');
    }
    const archivedCount = newLines.filter(l => l.startsWith('- [x]')).length;
    console.log(`${logPrefix} Archived ${archivedCount} items → archive/${dayPath}.md`);
  }
}


