// lib.mjs — shared module for REM memory system
// Single source of truth for paths, frontmatter, index format, file collection, state.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';

// ── Paths ──

export const repoRoot = process.cwd();
export const memoryDir = join(repoRoot, '.claude', 'memory');
export const rulesDir = join(repoRoot, '.claude', 'rules');
export const remRulesDir = join(rulesDir, 'rem');
export const indexFile = join(rulesDir, 'MEMORY.md');
export const stateFile = join(repoRoot, '.claude', '.rem-state.json');
export const MAX_ENTRIES = 20;
export const STALE_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

// ── Frontmatter ──

const FM_RE = /^---\n([\s\S]*?)\n---/;

export function parseFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { fm: '', body: content, fields: {} };
  const fm = m[1];
  const fields = {};
  for (const line of fm.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fm, body: content.slice(m[0].length), fields };
}

export function getField(content, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

export function setField(content, key, value) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, `${key}: ${value}`);
  }
  // Insert after the last frontmatter field before closing ---
  const fmEnd = content.indexOf('\n---');
  if (fmEnd < 0) return content;
  const before = content.slice(0, fmEnd);
  const after = content.slice(fmEnd);
  return before + `\n${key}: ${value}` + after;
}

export function getTier(content) {
  return getField(content, 'tier') || 'short';
}

export function setTier(content, tier) {
  return setField(content, 'tier', tier);
}

export function hasAllFields(content) {
  return /^created:/m.test(content) && /^accessed:/m.test(content) && /^tier:/m.test(content);
}

export function stampMissingFields(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (hasAllFields(content)) return false;
  const date = extractDateFromPath(filePath);
  let updated = content;
  if (!/^created:/m.test(updated)) updated = setField(updated, 'created', date);
  if (!/^accessed:/m.test(updated)) updated = setField(updated, 'accessed', date);
  if (!/^tier:/m.test(updated)) updated = setField(updated, 'tier', 'short');
  writeFileSync(filePath, updated, 'utf8');
  return true;
}

export function bumpAccessed(content, date) {
  return setField(content, 'accessed', date);
}

// ── Date helpers ──

export function todayISO(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === 'string') return date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function parseDate(s) {
  return new Date(s).getTime();
}

export function dayPrecision(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function extractDateFromPath(filePath) {
  const d = dirname(filePath);
  const name = basename(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return name;
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch { return todayISO(); }
}

// ── Path security ──

export function resolveMemoryPath(relPath) {
  return resolve(memoryDir, relPath);
}

export function isInsideMemoryDir(absPath) {
  const resolved = resolve(absPath);
  const memResolved = resolve(memoryDir);
  return resolved.startsWith(memResolved + '\\') || resolved.startsWith(memResolved + '/') || resolved === memResolved;
}

// ── Index ──

export const INDEX_HEADER = `# Memory Index

<!--
Three-tier memory system:
  1. Rules (.claude/rules/)         — always injected, core behavioral constraints only
  2. Long-term memory (tier: long)  — progressive disclosure, demoted to short if inactive between prune cycles
  3. Short-term memory (tier: short) — progressive disclosure, 90d eviction

Promotion: run \`node scripts/touch-memory.js <path> --promote\` to upgrade short → long
Demotion:  long-term not accessed between two prune cycles → auto-demoted to short
Prune:     run \`node scripts/prune-memory.js --evict-stale\` (short-term eviction + long-term demotion check)
Compact:   run \`node scripts/compact.js --check\` when index grows large

Frontmatter:
  - created:  ISO date (parent folder date)
  - accessed: ISO date (bumped by touch-memory.js on reference)
  - tier:     long | short (default short, promoted via touch-memory.js --promote)
-->

`;

// Regex to match and parse an index entry line
const ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\s+(.+?)\]\(\.\.\/memory\/(.+?\.md)\)\s*—\s*`created:\s*(\d{4}-\d{2}-\d{2}),\s*accessed:\s*(\d{4}-\d{2}-\d{2})`/;

export function parseIndexEntry(line) {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  return {
    date: m[1],
    title: m[2],
    path: m[3],
    created: m[4],
    accessed: m[5],
    accessedDate: parseDate(m[5]),
    line,
  };
}

export function formatIndexEntry(entry) {
  return `- [${entry.date} ${entry.title}](../memory/${entry.path}) — \`created: ${entry.created}, accessed: ${entry.accessed}\``;
}

// Returns updated content on match, null if the memory path wasn't found in the index.
export function updateIndexAccessed(indexContent, memPath, newAccessed) {
  const escaped = memPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the separator generically — em-dash, en-dash, or plain dash with optional spaces
  const re = new RegExp(
    `(\\]\\(\.\.\\/memory\\/${escaped}\\)\\s+.{1,3}\\s+\`created:\\s*[^,]+),\\s*accessed:\\s*[^\`]+\``
  );
  if (!re.test(indexContent)) return null;
  return indexContent.replace(re, `$1, accessed: ${newAccessed}\``);
}

export function parseIndex(content) {
  const lines = content.split('\n');
  const header = [];
  const entries = [];
  for (const line of lines) {
    const e = parseIndexEntry(line);
    if (e) {
      entries.push(e);
    } else if (entries.length === 0) {
      header.push(line);
    }
  }
  return { header, entries };
}

// ── File collection ──

export function collectMemoryFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectMemoryFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

// ── State management ──

const DEFAULT_STATE = {
  hook: {
    sessionKey: null,
    stopCount: 0,
    firstStopAt: null,
    remPending: false,
    remDone: false,
    lastTouched: null,
    taskActiveUntil: null,
  },
  prune: {
    lastPruneAt: 0,
    events: [],
  },
};

export function loadState() {
  try {
    if (!existsSync(stateFile)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const raw = readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

export function saveState(state) {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function appendEvent(type, detail) {
  const state = loadState();
  state.prune.events.push({ ts: new Date().toISOString(), type, ...detail });
  // Keep last 50 events
  if (state.prune.events.length > 50) {
    state.prune.events = state.prune.events.slice(-50);
  }
  saveState(state);
}

// ── Module & category inference ──

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

// ── Memory cross-reference & finding-to-memory ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;

export function collectMemoryRefs(memDir = memoryDir) {
  const refs = new Map();   // slug → { name, description, path }
  const idIndex = new Map(); // SR-YYYYMMDD-NNN → relPath
  if (!existsSync(memDir)) return { refs, idIndex };

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
          const relPath = relative(memDir, full).replace(/\\/g, '/');
          if (nameMatch) {
            refs.set(nameMatch[1].trim(), {
              name: nameMatch[1].trim(),
              description: descMatch ? descMatch[1].trim() : '',
              path: relPath,
            });
          }
          for (const m of content.matchAll(SR_ID_RE)) {
            if (!idIndex.has(m[0])) idIndex.set(m[0], relPath);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }
  walk(memDir);
  return { refs, idIndex };
}

export function crossReferenceFindings(findings, memoryRefs, idIndex) {
  for (const f of findings) {
    f.memoryRef = idIndex.get(f.id) || null;
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

export function writeBackMemoryRefs(findings, memDir = memoryDir) {
  let written = 0;
  for (const f of findings) {
    if (!f.memoryRef) continue;
    const memFile = join(memDir, f.memoryRef);
    if (!existsSync(memFile)) continue;
    try {
      let content = readFileSync(memFile, 'utf8');
      if (content.includes(f.id)) continue;
      const refLine = `\nRelated finding: [[${f.id}]]\n`;
      content = content.trimEnd() + refLine;
      writeFileSync(memFile, content, 'utf8');
      written++;
    } catch { /* skip unwritable files */ }
  }
  return written;
}

export function findingMemoryPath(finding, today) {
  const date = (finding.discovered || today || '').replace(/-/g, '');
  if (date.length !== 8) return null;
  const dir = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return { dir, file: `${finding.id}.md`, relPath: `${dir}/${finding.id}.md` };
}

export function findingToMemoryEntry(finding, memDir = memoryDir, today) {
  if (finding.severity !== 'HIGH' && finding.severity !== 'MEDIUM') return null;

  const pm = findingMemoryPath(finding, today);
  if (!pm) return null;

  const dirPath = join(memDir, pm.dir);
  const filePath = join(dirPath, pm.file);

  if (existsSync(filePath)) return pm.relPath;

  const date = today || todayISO();
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
    `accessed: ${date}`,
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
