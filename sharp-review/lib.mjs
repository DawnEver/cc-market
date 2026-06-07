// lib.mjs — Sharp Review shared library
// Constants, helpers, and memory cross-reference logic

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';

// ── Paths (relative to project root) ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(ROOT, '.claude', 'memory');

// ── Constants ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;
export const SR_ID_PARSE_RE = /^SR-(\d{8})-(\d{3})$/;
export const FINDING_HDR_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
export const STATUS_RE = /^\s*-?\s*\*\*Status:\*\*\s*(\w+)/m;

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
      // Insert under ## Related Findings section, or append one
      const sectionHeader = '## Related Findings';
      if (content.includes(sectionHeader)) {
        const idx = content.indexOf(sectionHeader);
        const afterHeader = content.indexOf('\n', idx);
        const before = content.slice(0, afterHeader + 1);
        const after = content.slice(afterHeader + 1);
        content = before + `- [[${f.id}]]\n` + after;
      } else {
        content = content.trimEnd() + `\n\n${sectionHeader}\n- [[${f.id}]]\n`;
      }
      writeFileSync(memFile, content, 'utf8');
      written++;
    } catch { /* skip unwritable files */ }
  }
  return written;
}

// ── Review Frontmatter ──

export function reviewFrontmatter(findings, date) {
  const count = Array.isArray(findings) ? findings.length : 0;
  const desc = `Sharp review findings — ${count} total`;
  return [
    '---',
    `name: sharp-review-${date}`,
    `description: ${desc}`,
    'metadata:',
    '  type: project',
    `created: ${date}`,
    `accessed: ${date}`,
    'tier: short',
    '---',
  ].join('\n');
}

// ── Markdown parsing ──

export function parseFindingsFromMarkdown(content, date) {
  const findings = [];
  const blocks = content.split(/\n(?=###\s+\[SR-)/);
  for (const block of blocks) {
    const hdr = block.match(FINDING_HDR_RE);
    if (!hdr) continue;
    const statusMatch = block.match(STATUS_RE);
    const status = statusMatch ? statusMatch[1].toLowerCase() : 'open';
    const resolvedDate = status === 'fixed' ? date : null;
    findings.push({
      id: hdr[1],
      severity: hdr[2],
      file: hdr[3].trim(),
      summary: hdr[4].trim(),
      status,
      discovered: hdr[1].slice(3, 11).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      resolvedDate,
      category: 'Bug',
      module: 'unknown',
      suggestion: '',
      detail: '',
    });
  }
  return findings;
}
