#!/usr/bin/env node
// sync-tasks.js — sharp-review thin wrapper
// Parses findings from .claude/sharp-review/YYYY-MM-DD.md, then delegates to rem's task engine.
// Pass-through: --resolve, --check, --report go directly to rem.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';
import { inferModule, inferCategory } from '../lib.mjs';

// ── Paths ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REM_SYNC_TASKS = join(ROOT, 'cc-market', 'rem', 'scripts', 'sync-tasks.js');
const SHARP_REVIEW_DIR = join(ROOT, '.claude', 'sharp-review');

// ── Pass-through commands (no findings parsing needed) ──

const args = process.argv.slice(2);
const passThrough = args.some(a => a === '--resolve' || a === '--check' || a === '--report');

if (passThrough) {
  // Forward directly to rem's sync-tasks
  try {
    const result = execFileSync('node', [REM_SYNC_TASKS, ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
    });
    if (result) process.stdout.write(result);
    process.exit(0);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    process.exit(e.status || 1);
  }
}

// ── Finding parsing (sharp-review specific) ──

const FINDING_HEADER_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
const LEGACY_FINDING_RE = /^\[(\w+)\]\s+(.+?)\s+—\s+(.+?)(?:\s+→\s+(.+))?$/;
const KV_RE = /^-\s+\*\*(.+?):\*\*\s+(.+)/;

function parseFindings(content, fileDate) {
  const findings = [];
  const lines = content.split('\n');
  let i = 0;
  let legacySeq = 0;

  while (i < lines.length) {
    const hdr = lines[i].match(FINDING_HEADER_RE);
    if (hdr) {
      const finding = {
        id: hdr[1],
        severity: hdr[2],
        file: hdr[3].trim(),
        summary: hdr[4].trim(),
        category: null,
        module: null,
        status: 'open',
        discovered: (() => { const d = hdr[1].slice(3,11); return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`; })(),
        suggestion: '',
        detail: '',
      };
      i++;
      while (i < lines.length && lines[i].trim() !== '---' && !lines[i].startsWith('### [')) {
        const kv = lines[i].match(KV_RE);
        if (kv) {
          const key = kv[1].toLowerCase();
          const val = kv[2].trim();
          if (key === 'category') finding.category = val;
          else if (key === 'module') finding.module = val;
          else if (key === 'status') finding.status = val.toLowerCase();
          else if (key === 'discovered') finding.discovered = val;
          else if (key === 'suggestion') finding.suggestion = val;
          else if (key === 'description') finding.detail = val;
        }
        i++;
      }
      if (!finding.module) finding.module = inferModule(finding.file);
      if (!finding.category) finding.category = inferCategory(finding.summary, finding.category);
      findings.push(finding);
      if (i < lines.length && lines[i].trim() === '---') i++;
      continue;
    }

    const leg = lines[i].match(LEGACY_FINDING_RE);
    if (leg) {
      legacySeq++;
      const id = `SR-${fileDate}-L${String(legacySeq).padStart(2, '0')}`;
      const status = leg[4] && /FIXED|fixed|已修复/i.test(leg[4]) ? 'fixed' : 'open';
      const maybeFile = leg[2].trim();
      const looksLikeFile = /\.[jt]sx?$|\.[mc]js$|\.md$|\.json$|\.ya?ml$|\.sh$|\.py$|\//.test(maybeFile) && maybeFile.length < 80;
      const file = looksLikeFile ? maybeFile : '';
      const summary = looksLikeFile ? leg[3].trim() : `${maybeFile} — ${leg[3].trim()}`;
      const detailLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---' && !lines[j].startsWith('### [') && !lines[j].match(/^\[(\w+)\]\s+/)) {
        if (lines[j].trim()) detailLines.push(lines[j].trim());
        j++;
      }
      findings.push({
        id,
        severity: leg[1],
        file,
        summary,
        category: inferCategory(summary, null),
        module: inferModule(file),
        status,
        discovered: fileDate,
        suggestion: leg[4] ? leg[4].trim() : '',
        detail: detailLines.join('\n'),
      });
      i = j;
      continue;
    }
    i++;
  }

  return findings;
}

function collectSharpReviewFiles() {
  if (!existsSync(SHARP_REVIEW_DIR)) return [];
  const results = [];
  for (const entry of readdirSync(SHARP_REVIEW_DIR)) {
    if (entry.endsWith('.md')) {
      const match = entry.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (match) {
        results.push({ path: join(SHARP_REVIEW_DIR, entry), date: match[1] });
      }
    }
  }
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results;
}

// ── Main: collect findings → delegate to rem ──

const reviewFiles = collectSharpReviewFiles();
const allFindings = [];

for (const { path, date } of reviewFiles) {
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { continue; }
  const findings = parseFindings(content, date);
  for (const f of findings) {
    f.sourceFile = relative(ROOT, path).replace(/\\/g, '/');
  }
  allFindings.push(...findings);
}

if (allFindings.length === 0) {
  console.log('[sync-tasks] No findings found — skipping sync');
  process.exit(0);
}

// Write findings to temp JSON and delegate to rem
const tmpDir = join(ROOT, 'node_modules', '.tmp');
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
const tmpFile = join(tmpDir, 'sharp-review-findings.json');
writeFileSync(tmpFile, JSON.stringify(allFindings, null, 2), 'utf8');

try {
  const result = execFileSync('node', [REM_SYNC_TASKS, '--findings', tmpFile], {
    cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result) process.stdout.write(result);
} catch (e) {
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  process.exit(e.status || 1);
}
