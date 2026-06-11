#!/usr/bin/env node
// post-review.js — write sharp review result as a rem memory entry
// Takes workflow output ({ markdown, merged }) and creates
// .claude/memory/YYYY/MM/DD/sharp-review.md with proper frontmatter.
// Indexes via stamp-memory.js, archives resolved findings, syncs tasks.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { reviewFrontmatter, parseFindingsFromMarkdown } from '../lib.mjs';
import { resolvePluginDir } from '../shared/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(ROOT, '.claude', 'memory');

const REM_DIR = resolvePluginDir('rem', __dirname);
const STAMP_SCRIPT = join(REM_DIR, 'scripts', 'stamp-memory.js');

// ── Parse args ──

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }
function hasArg(args, flag) { return args.includes(flag); }

const args = process.argv.slice(2);
const date = getArg(args, '--date');
const findingsFile = getArg(args, '--findings');
const markdownFile = getArg(args, '--markdown');
const rescan = hasArg(args, '--rescan');
const datePath = date.replace(/-/g, '/');
const memFile = join(MEMORY_DIR, datePath, 'sharp-review.md');

// ── --rescan: re-read memory file, parse statuses, re-sync tasks ──

if (rescan) {
  if (!existsSync(memFile)) {
    console.error(`[post-review] No review file for ${date}: ${memFile}`);
    process.exit(1);
  }
  const content = readFileSync(memFile, 'utf8');
  const findings = parseFindingsFromMarkdown(content, date);
  if (findings.length === 0) {
    console.log(`[post-review] No findings found in ${memFile}`);
    process.exit(0);
  }
  const updatedFrontmatter = reviewFrontmatter(findings, date);
  const body = content.slice(content.indexOf('\n---\n') + 5);
  writeFileSync(memFile, `${updatedFrontmatter}\n${body}`, 'utf8');
  console.log(`[post-review] Rescanned: ${findings.length} findings, frontmatter updated`);

  const open = findings.filter(f => f.status !== 'fixed' && f.status !== 'FIXED').length;
  console.log(`[post-review] Done — ${findings.length} findings, ${open} open`);
  process.exit(0);
}

// ── New review: write memory entry ──

if (!findingsFile || !markdownFile) {
  console.error('[post-review] Expected --findings <json-file> --markdown <md-file> (or --rescan)');
  process.exit(1);
}

if (!existsSync(findingsFile)) {
  console.error(`[post-review] Findings file not found: ${findingsFile}`);
  process.exit(1);
}
if (!existsSync(markdownFile)) {
  console.error(`[post-review] Markdown file not found: ${markdownFile}`);
  process.exit(1);
}

let findings = JSON.parse(readFileSync(findingsFile, 'utf8'));
let markdown = readFileSync(markdownFile, 'utf8');

// Merge with existing session file if same-day re-review
if (existsSync(memFile)) {
  const existingContent = readFileSync(memFile, 'utf8');
  const existingFindings = parseFindingsFromMarkdown(existingContent, date);
  const existingIds = new Map(existingFindings.map(f => [f.id, f]));
  const seen = new Set();
  for (const f of findings) {
    if (existingIds.has(f.id)) seen.add(f.id);
    else existingIds.set(f.id, f);
  }
  findings = [...existingIds.values()];
  markdown = existingContent.slice(existingContent.indexOf('\n---\n') + 5)
    + `\n\n## Review ${date} (follow-up)\n\n` + markdown;
  if (seen.size > 0) console.log(`[post-review] Merged: ${seen.size} duplicate IDs retained existing statuses`);
  console.log(`[post-review] Appended to existing session file (${findings.length} total findings)`);
}

const frontmatter = reviewFrontmatter(findings, date);
const dirPath = join(MEMORY_DIR, datePath);
if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
writeFileSync(memFile, `${frontmatter}\n\n${markdown}`, 'utf8');
console.log(`[post-review] Written: ${memFile}`);// ── Index with stamp-memory.js ──

try {
  execFileSync('node', [STAMP_SCRIPT], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  console.log('[post-review] stamp-memory.js OK');
} catch (e) {
  console.error(`[post-review] stamp-memory.js failed: ${e.stderr || e.message}`);
}

const open = findings.filter(f => f.status !== 'fixed' && f.status !== 'FIXED').length;
console.log(`[post-review] Done — ${findings.length} findings, ${open} open`);

// ── Helpers ──




