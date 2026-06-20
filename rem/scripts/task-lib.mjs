// task-lib.mjs — pure task management logic (owned by rem)
// Used by task-engine.js (CLI) and callable from post-review.js / tests.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { DAY_MS } from '../lib.mjs';
import { SR_FINDING_HDR_RE, SR_STATUS_RE, reviewFrontmatter, parseFindingsFromMarkdown, inferModuleFromPath } from '../shared/lib.mjs';
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

// Heuristic confidence that an open finding is already resolved:
//   'high'   → the referenced file no longer exists (clearly addressed/removed)
//   'medium' → the file was modified after the finding was discovered
//   null     → no signal (or no file to check)
export function resolvedConfidence(finding, today) {
  if (!finding.file) return null;
  try {
    const absPath = join(ROOT, finding.file);
    if (!existsSync(absPath)) return 'high';
    const mtime = statSync(absPath).mtimeMs;
    const discovered = new Date(finding.discovered).getTime();
    const todayStart = new Date(today).getTime();
    if (discovered >= todayStart) return null;
    return mtime > discovered ? 'medium' : null;
  } catch { return null; }
}

export function checkFileModified(finding, today) {
  return resolvedConfidence(finding, today) !== null;
}

// Severity ordering for sorting (lower = more urgent).
export const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
export function severityRank(sev) {
  const r = SEVERITY_ORDER[(sev || '').toUpperCase()];
  return r === undefined ? 3 : r;
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
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
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
              module: moduleMatch ? moduleMatch[1].trim() : inferModuleFromPath(hdr[3].trim()),
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

// Cap the visible summary text (the "show <id>" suffix is added on top, so a
// truncated line is intentionally longer than SUMMARY_MAX — the cap bounds the
// noisy finding text, not the whole line).
const SUMMARY_MAX = 100;
function truncateSummary(s, id) {
  if (!s || s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX).trimEnd()}… (todo show ${id})`;
}

function severityCounts(items) {
  const c = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of items) {
    const s = (f.severity || '').toUpperCase();
    if (c[s] !== undefined) c[s]++;
  }
  const parts = [];
  if (c.HIGH) parts.push(`${c.HIGH} HIGH`);
  if (c.MEDIUM) parts.push(`${c.MEDIUM} MEDIUM`);
  if (c.LOW) parts.push(`${c.LOW} LOW`);
  return parts.join(', ');
}

export function formatScopeReport(allFindings, allManual, today, opts = {}) {
  const { moduleFilter = null, sortBySeverity = false } = opts;
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
  let renderedScopes = 0;

  const resolvedHints = [];

  for (const [scope, { findings, manual }] of byScope) {
    const scopeRel = relative(ROOT, scope).replace(/\\/g, '/') || '.';
    let allOpen = [
      ...findings.filter(f => f.status === 'open'),
      ...manual.filter(t => t.status === 'open'),
    ];
    if (moduleFilter) allOpen = allOpen.filter(f => (f.module || 'unknown') === moduleFilter);

    if (allOpen.length === 0 && findings.length === 0 && manual.length === 0) continue;
    if (moduleFilter && allOpen.length === 0) continue;

    // Footer counts must respect --module: count only the filtered module's items,
    // not every finding in the scope (otherwise "(N findings)" overstates).
    const inFilter = f => !moduleFilter || (f.module || 'unknown') === moduleFilter;
    totalOpen += allOpen.length;
    totalFindings += findings.filter(inFilter).length;
    totalManual += manual.filter(inFilter).length;
    renderedScopes++;

    const sevSummary = severityCounts(allOpen);
    lines.push(`${PREFIX} scope: ${scopeRel} (${allOpen.length} open${sevSummary ? ` — ${sevSummary}` : ''})`);

    if (allOpen.length > 0) {
      const byMod = groupByModule(allOpen);
      const sorted = [...byMod].sort(([a], [b]) => a.localeCompare(b));

      for (const [mod, items] of sorted) {
        const ordered = sortBySeverity
          ? [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
          : items;
        lines.push(`  ## ${mod}`);
        for (const f of ordered) {
          const stale = isStale(f, today) ? ' ⚠ stale' : '';
          const conf = resolvedConfidence(f, today);
          const likely = conf ? ` ⚠ likely-resolved (${conf})` : '';
          if (conf) resolvedHints.push({ id: f.id, conf });
          lines.push(`  - [ ] ${f.id} [${f.severity}] ${truncateSummary(f.summary, f.id)} (${f.discovered})${stale}${likely}`);
        }
      }
    }
    lines.push('');
  }

  if (resolvedHints.length > 0) {
    lines.push(`${PREFIX} ${resolvedHints.length} likely-resolved — close with:`);
    for (const { id, conf } of resolvedHints) {
      lines.push(`  todo mark ${id} fixed   # ${conf} confidence`);
    }
    lines.push(`  (or run: todo report --auto-close-resolved  to auto-close high-confidence)`);
    lines.push('');
  }

  const scopeCount = renderedScopes; // count only scopes actually shown (respects --module)

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

// ── Report flag parsing ──
//
// Parses the option flags accepted by `todo report` / `todo check`:
//   --module <name>            → opts.moduleFilter
//   --severity | --sort        → opts.sortBySeverity
//   --auto-close-resolved [all]→ opts.autoClose ('high' | 'all')
export function parseReportOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--module' && args[i + 1]) opts.moduleFilter = args[++i];
    else if (args[i] === '--severity' || args[i] === '--sort') opts.sortBySeverity = true;
    else if (args[i] === '--auto-close-resolved') {
      if (args[i + 1] === 'all') { i++; opts.autoClose = 'all'; }
      else opts.autoClose = 'high';
    }
  }
  return opts;
}

// ── Show full detail of a single finding/task ──

export function getFindingDetail(memDir, id) {
  const fileName = id.startsWith('SR-') ? 'sharp-review.md'
    : id.startsWith('MANUAL-') ? 'manual.md' : null;
  if (!fileName) return { found: false, error: `Unknown ID format: ${id}` };

  let result = null;
  walkFiles(memDir, fileName, full => {
    const content = readFileSync(full, 'utf8');
    if (!content.includes(id)) return false;
    if (fileName === 'sharp-review.md') {
      const blocks = content.split(/\n(?=###\s+\[SR-)/);
      const block = blocks.find(b => b.includes(`[${id}]`));
      if (!block) return false;
      result = { found: true, file: full, text: block.trim() };
    } else {
      const lines = content.split('\n');
      const idx = lines.findIndex(l => l.includes(id));
      if (idx < 0) return false;
      const out = [lines[idx]];
      // Continuation lines are indented (canonically 6 spaces); accept any
      // leading-whitespace line so non-standard indentation isn't silently dropped.
      for (let i = idx + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) out.push(lines[i]);
      result = { found: true, file: full, text: out.join('\n').trim() };
    }
    return true;
  });

  return result || { found: false, error: `${id} not found` };
}

export function markFinding(memDir, id, status) {
  let norm = (status || '').toLowerCase();
  if (norm === 'done' || norm === 'resolved') norm = 'fixed'; // friendly aliases
  if (!VALID_STATUSES.includes(norm)) {
    return { found: false, error: `Invalid status: ${status} (expected open|fixed|closed)` };
  }
  if (id.startsWith('SR-')) return markSRFinding(memDir, id, norm);
  if (id.startsWith('MANUAL-')) return markManualTask(memDir, id, norm);
  return { found: false, error: `Unknown ID format: ${id} (expected SR-* or MANUAL-* ID)` };
}
