// lib.mjs — Sharp Review shared library
// Constants, helpers, and memory cross-reference logic

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, relative } from 'path';

// ── Paths (relative to project root) ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(ROOT, '.claude', 'memory');

// ── Constants ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;
export const SR_ID_PARSE_RE = /^SR-(\d{8})-(\d{3})$/;

// ── Date helpers (no Date.now() — callers pass explicit date) ──

export function todayISO(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === 'string') return date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

// ── Module inference ──

const MODULE_MAP = [
  { pattern: /cc-market[/\\]takeover/, name: 'takeover plugin' },
  { pattern: /scripts[/\\]hooks[/\\]notify/, name: 'notify hook' },
  { pattern: /scripts[/\\]runtime[/\\]notify/, name: 'notify hook' },
  { pattern: /scripts[/\\]hooks[/\\]sharp-review/, name: 'sharp review hook' },
  { pattern: /skills[/\\]sharp-review/, name: 'sharp review skill' },
  { pattern: /scripts[/\\]runtime[/\\]api-proxy/, name: 'api-proxy' },
  { pattern: /scripts[/\\]runtime[/\\]cc\./, name: 'cc runtime' },
  { pattern: /scripts[/\\]hooks[/\\]hud/, name: 'hud hook' },
  { pattern: /scripts[/\\]setup/, name: 'setup scripts' },
  { pattern: /cc-market[/\\]rem/, name: 'rem plugin' },
  { pattern: /\.claude[/\\]rules/, name: 'claude rules' },
  { pattern: /\.claude[/\\]memory/, name: 'claude memory' },
  { pattern: /claude_settings/, name: 'claude settings' },
  { pattern: /GLOBAL-AGENTS/, name: 'global config' },
  { pattern: /AGENTS\.md/, name: 'project config' },
  { pattern: /README\.md/, name: 'documentation' },
];

export function inferModule(filePath) {
  if (!filePath) return 'unknown';
  const normalized = filePath.replace(/\\/g, '/');
  for (const { pattern, name } of MODULE_MAP) {
    if (pattern.test(normalized)) return name;
  }
  const parts = normalized.split('/');
  const lastFile = parts[parts.length - 1] || '';
  const lastDir = parts.length > 1 ? parts[parts.length - 2] : '';
  return lastDir || lastFile.replace(/\.[^.]+$/, '') || 'unknown';
}

// ── Category inference ──

export function inferCategory(summary, explicit) {
  if (explicit) {
    const cat = explicit.toLowerCase();
    if (cat === 'bug' || cat === 'perf' || cat === 'performance' || cat === 'feature') {
      return cat === 'perf' ? 'Performance' : cat[0].toUpperCase() + cat.slice(1);
    }
  }
  if (!summary) return 'Bug';
  const s = summary.toLowerCase();
  if (/performance|slow|optimize|latency|memory leak|memory usage/i.test(s)) return 'Performance';
  if (/feature|support|add |implement|new capability/i.test(s)) return 'Feature';
  return 'Bug';
}

// ── Memory cross-reference ──

export function collectMemoryRefs(memoryDir = MEMORY_DIR) {
  const refs = new Map();   // slug → { name, description, path }
  const idIndex = new Map(); // SR-YYYYMMDD-NNN → relPath
  if (!existsSync(memoryDir)) return { refs, idIndex };

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'tasks') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = readFileSync(full, 'utf8');
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          const relPath = relative(memoryDir, full).replace(/\\/g, '/');
          if (nameMatch) {
            refs.set(nameMatch[1].trim(), {
              name: nameMatch[1].trim(),
              description: descMatch ? descMatch[1].trim() : '',
              path: relPath,
            });
          }
          // Index every SR-ID mentioned in this file
          for (const m of content.matchAll(SR_ID_RE)) {
            if (!idIndex.has(m[0])) idIndex.set(m[0], relPath);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }
  walk(memoryDir);
  return { refs, idIndex };
}

export function crossReferenceFindings(findings, memoryRefs, idIndex) {
  for (const f of findings) {
    f.memoryRef = idIndex.get(f.id) || null;
    // Fallback: description prefix match
    if (!f.memoryRef) {
      const summaryLower = f.summary.toLowerCase().slice(0, 30);
      for (const ref of memoryRefs.values()) {
        if (ref.description.toLowerCase().includes(summaryLower)) {
          f.memoryRef = ref.path;
          break;
        }
      }
    }
  }
}

// ── Write-back: persist SR-IDs into referenced memory files ──

export function writeBackMemoryRefs(findings, memoryDir = MEMORY_DIR) {
  let written = 0;
  for (const f of findings) {
    if (!f.memoryRef) continue;
    const memFile = join(memoryDir, f.memoryRef);
    if (!existsSync(memFile)) continue;
    try {
      let content = readFileSync(memFile, 'utf8');
      // Check if SR-ID already present
      if (content.includes(f.id)) continue;
      // Append wiki-link reference before any trailing newlines
      const refLine = `\nRelated finding: [[${f.id}]]\n`;
      content = content.trimEnd() + refLine;
      writeFileSync(memFile, content, 'utf8');
      written++;
    } catch { /* skip unwritable files */ }
  }
  return written;
}

// ── Finding → Memory Entry ──

export function findingMemoryPath(finding) {
  // Derive date directory from SR-ID or discovered field
  const date = (finding.discovered || '').replace(/-/g, '');
  if (date.length !== 8) return null;
  const dir = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return { dir, file: `${finding.id}.md`, relPath: `${dir}/${finding.id}.md` };
}

export function findingToMemoryEntry(finding, memoryDir = MEMORY_DIR) {
  // Only create memory entries for HIGH and MEDIUM findings
  if (finding.severity !== 'HIGH' && finding.severity !== 'MEDIUM') return null;

  const pm = findingMemoryPath(finding);
  if (!pm) return null;

  const dirPath = join(memoryDir, pm.dir);
  const filePath = join(dirPath, pm.file);

  // Don't overwrite existing entries (idempotent)
  if (existsSync(filePath)) return pm.relPath;

  const today = todayISO();
  const body = [
    '---',
    `name: ${finding.id}`,
    `description: [${finding.severity}] ${finding.summary.slice(0, 120)}`,
    'metadata:',
    '  type: project',
    `  category: ${finding.category || 'Bug'}`,
    `  module: ${finding.module || 'unknown'}`,
    `  status: open`,
    `  source: sharp-review`,
    `created: ${pm.dir}`,
    `accessed: ${today}`,
    'tier: short',
    '---',
    '',
    `# ${finding.id} [${finding.severity}] ${finding.file || ''} — ${finding.summary}`,
    '',
    `**Category:** ${finding.category || 'Bug'}`,
    `**Module:** ${finding.module || 'unknown'}`,
    `**Discovered:** ${pm.dir}`,
    '',
  ];

  if (finding.detail) {
    body.push(finding.detail);
    body.push('');
  }

  if (finding.suggestion) {
    body.push(`**Suggested fix:** ${finding.suggestion}`);
    body.push('');
  }

  body.push(`Open in tasks: [[../tasks/tasks.md#${finding.id.toLowerCase()}]]`);

  try {
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    writeFileSync(filePath, body.join('\n') + '\n', 'utf8');
    return pm.relPath;
  } catch { return null; }
}
