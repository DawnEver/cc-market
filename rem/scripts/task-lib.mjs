// task-lib.mjs — pure task management logic (owned by rem)
// Used by task-engine.js (CLI) and callable from post-review.js / tests.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { DAY_MS } from '../lib.mjs';
import { SR_FINDING_HDR_RE, SR_STATUS_RE, reviewFrontmatter, parseFindingsFromMarkdown } from '../shared/lib.mjs';
import { findAllScopes, extractDateFromPath } from '../lib.mjs';

// ── Paths ──

export const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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

// ── Multi-scope scanning ──

export function scanAllScopes() {
  const scopes = findAllScopes();
  const allFindings = [];
  const allManual = [];

  for (const scope of scopes) {
    const memDir = join(scope, '.claude', 'memory');
    const findings = scanMemoryForFindings(memDir);
    const manual = scanManualTasks(memDir);

    for (const f of findings) f._scopeRoot = scope;
    for (const t of manual) t._scopeRoot = scope;

    allFindings.push(...findings);
    allManual.push(...manual);
  }

  return { findings: allFindings, manual: allManual };
}

export function formatScopeReport(allFindings, allManual, today) {
  const lines = [];
  const PREFIX = '[task-engine]';

  // Group by scope
  const byScope = new Map();
  for (const f of allFindings) {
    const scope = f._scopeRoot;
    if (!byScope.has(scope)) byScope.set(scope, { findings: [], manual: [] });
    byScope.get(scope).findings.push(f);
  }
  for (const t of allManual) {
    const scope = t._scopeRoot;
    if (!byScope.has(scope)) byScope.set(scope, { findings: [], manual: [] });
    byScope.get(scope).manual.push(t);
  }

  if (byScope.size === 0) {
    lines.push(`${PREFIX} No tasks found`);
    return lines.join('\n');
  }

  let totalOpen = 0;
  let totalFindings = 0;
  let totalManual = 0;

  for (const [scope, { findings, manual }] of byScope) {
    const scopeRel = relative(ROOT, scope).replace(/\\/g, '/') || '.';
    const allOpen = [
      ...findings.filter(f => f.status === 'open'),
      ...manual.filter(t => t.status === 'open'),
    ];

    if (allOpen.length === 0 && findings.length === 0 && manual.length === 0) continue;

    totalOpen += allOpen.length;
    totalFindings += findings.length;
    totalManual += manual.length;

    lines.push(`${PREFIX} scope: ${scopeRel} (${allOpen.length} open)`);

    if (allOpen.length > 0) {
      const byMod = groupByModule(allOpen);
      const sorted = [...byMod].sort(([a], [b]) => a.localeCompare(b));

      for (const [mod, items] of sorted) {
        lines.push(`  ## ${mod}`);
        for (const f of items) {
          const stale = isStale(f, today) ? ' ⚠ stale' : '';
          const likely = checkFileModified(f, today) ? ' ⚠ likely-resolved' : '';
          lines.push(`  - [ ] ${f.id} [${f.severity}] ${f.summary} (${f.discovered})${stale}${likely}`);
        }
      }
    }
    lines.push('');
  }

  const scopeCount = [...byScope].filter(([_, v]) =>
    v.findings.length > 0 || v.manual.length > 0
  ).length;

  const parts = [];
  if (totalFindings > 0) parts.push(`${totalFindings} findings`);
  if (totalManual > 0) parts.push(`${totalManual} manual`);
  lines.push(`${PREFIX} total: ${totalOpen} open${parts.length > 0 ? ` (${parts.join(', ')})` : ''} across ${scopeCount} scope${scopeCount !== 1 ? 's' : ''}`);

  return lines.join('\n');
}

// ── Mark status (open/fixed/closed) ──

const VALID_STATUSES = ['open', 'fixed', 'closed'];

function walkFiles(dir, fileName, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (walkFiles(full, fileName, visit)) return true;
      continue;
    }
    if (entry.name === fileName && visit(full)) return true;
  }
  return false;
}

function markSRFinding(memDir, id, status) {
  let target = null;
  walkFiles(memDir, 'sharp-review.md', full => {
    const content = readFileSync(full, 'utf8');
    if (!content.includes(`[${id}]`)) return false;
    const updated = content.replace(
      new RegExp(`(### \\[${id}\\][\\s\\S]*?)\\*\\*Status:\\*\\*\\s*\\w+`),
      `$1**Status:** ${status.toUpperCase()}`
    );
    writeFileSync(full, updated, 'utf8');
    target = full;
    return true;
  });

  if (!target) return { found: false, error: `Finding ${id} not found in any sharp-review.md` };

  // Re-derive frontmatter — use path date, not today
  const content = readFileSync(target, 'utf8');
  const pathDate = extractDateFromPath(target);
  const findings = parseFindingsFromMarkdown(content, pathDate);
  if (findings.length > 0) {
    const updatedFrontmatter = reviewFrontmatter(findings, pathDate);
    const body = content.slice(content.indexOf('\n---\n') + 5);
    writeFileSync(target, `${updatedFrontmatter}\n${body}`, 'utf8');
  }

  return { found: true, file: target, id, status };
}

function markManualTask(memDir, id, status) {
  let target = null;
  const checked = status === 'open' ? ' ' : 'x';
  walkFiles(memDir, 'manual.md', full => {
    const content = readFileSync(full, 'utf8');
    if (!content.includes(id)) return false;
    const updated = content.replace(
      new RegExp(`- \\[[ x]\\] (${id}\\b)`),
      `- [${checked}] $1`
    );
    writeFileSync(full, updated, 'utf8');
    target = full;
    return true;
  });

  if (!target) return { found: false, error: `Task ${id} not found in any manual.md` };
  return { found: true, file: target, id, status };
}

export function markFinding(memDir, id, status) {
  const norm = (status || '').toLowerCase();
  if (!VALID_STATUSES.includes(norm)) {
    return { found: false, error: `Invalid status: ${status} (expected open|fixed|closed)` };
  }
  if (id.startsWith('SR-')) return markSRFinding(memDir, id, norm);
  if (id.startsWith('MANUAL-')) return markManualTask(memDir, id, norm);
  return { found: false, error: `Unknown ID format: ${id} (expected SR-* or MANUAL-* ID)` };
}
