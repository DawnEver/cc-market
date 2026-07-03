#!/usr/bin/env node
// post-review.js — write sharp review result as a rem memory entry
// Takes raw per-reviewer findings (--raw) and creates
// .claude/memory/YYYY/MM/DD/sharp-review.md with proper frontmatter.
// Indexes via shared upsertIndexEntry (no rem-plugin dependency), archives resolved
// findings, syncs tasks.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { reviewFrontmatter, parseFindingsFromMarkdown, mergeFollowup, mergeFindings, renderReviewMarkdown } from './lib.mjs';
import { upsertIndexEntry } from '../shared/stamp.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(ROOT, '.claude', 'memory');

// ── Parse args ──

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }
function hasArg(args, flag) { return args.includes(flag); }

const args = process.argv.slice(2);
const date = getArg(args, '--date');
const rawFile = getArg(args, '--raw');
const rescan = hasArg(args, '--rescan');

if (!date) {
  console.error('[post-review] --date <YYYY-MM-DD> is required');
  process.exit(1);
}

const datePath = date.replace(/-/g, '/');
const memFile = join(MEMORY_DIR, datePath, 'sharp-review.md');

function stripFrontmatter(text) {
  // Only strip a real leading frontmatter block. Without this guard the first
  // body '---' finding-separator would be mistaken for the frontmatter delimiter
  // on a (malformed) file that has no frontmatter, dropping the header + first finding.
  if (!text.startsWith('---')) return text;
  const i = text.indexOf('\n---\n');
  return i < 0 ? text : text.slice(i + 5);
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, data, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (e) {
    // Don't leave an orphan .tmp behind on a rename failure (Windows/OneDrive lock).
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}

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
  const body = stripFrontmatter(content);
  atomicWrite(memFile, `${updatedFrontmatter}\n${body}`);
  console.log(`[post-review] Rescanned: ${findings.length} findings, frontmatter updated`);

  const open = findings.filter(f => f.status !== 'fixed' && f.status !== 'FIXED').length;
  console.log(`[post-review] Done — ${findings.length} findings, ${open} open`);
  process.exit(0);
}

// ── New review: write memory entry ──
//
// --raw <file>: raw per-reviewer findings + reviewer metadata. Merge + render run HERE
// (via shared lib) instead of inside the host fan-out, so any host — a Claude Code worker
// subagent or Codex (spawn_agent / takeover call_model) — only has to collect raw reviewer
// output and hand it off. This keeps SR-id assignment and markdown rendering in one place,
// producing byte-identical output across hosts.

if (!rawFile) {
  console.error('[post-review] Expected --raw <json-file> (or --rescan)');
  process.exit(1);
}
if (!existsSync(rawFile)) {
  console.error(`[post-review] Raw findings file not found: ${rawFile}`);
  process.exit(1);
}
// { rawResults: [{ findings: [...] } | null], reviewers, active, profileLabel?,
//   dedupKeyFields?, idPrefix? } — rawResults is positionally aligned with `active`.
const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
const rawResults = raw.rawResults || [];
const reviewers = raw.reviewers || [];
const active = raw.active || reviewers;
const slotResults = {};
active.forEach((r, i) => { slotResults[r.key] = rawResults[i]; });
let findings = mergeFindings(rawResults, { dedupKeyFields: raw.dedupKeyFields, idPrefix: raw.idPrefix, date });
let { markdown } = renderReviewMarkdown(findings, { reviewers, slotResults, active, date, profileLabel: raw.profileLabel });

// Merge with existing session file if same-day re-review. Merge restarts
// sequence numbers at 001 each run, so renumber colliding incoming findings (and
// rewrite their ids in the incoming markdown) instead of dropping them — see
// mergeFollowup. This matters now that profile rotation can produce a diff review
// and an architecture review on the same day.
if (existsSync(memFile)) {
  const existingContent = readFileSync(memFile, 'utf8');
  const existingFindings = parseFindingsFromMarkdown(existingContent, date);
  const merged = mergeFollowup(existingFindings, findings, markdown);
  findings = merged.findings;
  markdown = stripFrontmatter(existingContent)
    + `\n\n## Review ${date} (follow-up)\n\n` + merged.markdown;
  if (merged.renumbered > 0) console.log(`[post-review] Renumbered ${merged.renumbered} follow-up findings to avoid ID collision`);
  console.log(`[post-review] Appended to existing session file (${findings.length} total findings)`);
}

// Note: we deliberately do NOT write an explicit `**Module:**` line per finding.
// The module is inferred lazily from the file path at scan/report time
// (shared/lib.mjs inferModuleFromPath, used by task-lib scanMemoryForFindings),
// so grouping stays correct even if a reviewer omits the module or a file is
// later moved — there's no stale module string to drift.
const frontmatter = reviewFrontmatter(findings, date);
const dirPath = join(MEMORY_DIR, datePath);
if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
atomicWrite(memFile, `${frontmatter}\n\n${markdown}`);
console.log(`[post-review] Written: ${memFile}`);

// ── Index the entry in MEMORY.md ──
// In-process upsert via shared/stamp.mjs — rem's rebuildIndex() regenerates the
// full index on next session start, so stamping just this entry keeps it coherent.

try {
  upsertIndexEntry(ROOT, `${datePath}/sharp-review.md`, { name: `sharp-review-${date}`, date });
  console.log('[post-review] index stamped');
} catch (e) {
  console.error(`[post-review] index stamp failed: ${e.message}`);
}

const open = findings.filter(f => f.status !== 'fixed' && f.status !== 'FIXED').length;
console.log(`[post-review] Done — ${findings.length} findings, ${open} open`);

