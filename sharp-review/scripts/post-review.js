#!/usr/bin/env node
// post-review.js — finish a planned run: merge the reviewers' raw results by the method's
// rules (lib/merge.mjs) and write one sink: `memory` (.claude/memory/YYYY/MM/DD/sharp-review.md)
// or `stdout` (the findings JSON, method/findings-output.schema.json). Default: the plan's sink.
//
//   node post-review.js --plan <plan.json> --raw <raw.json> [--sink memory|stdout]
//   node post-review.js --rescan --date <YYYY-MM-DD>     re-derive frontmatter after an edit
//
// raw.json: { run_id, results: [{ name, findings? | text? | error_kind?, error? }] } — `name` is the
// plan's reviewer name; see skills/sharp-review/reference/direct-fanout.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { reviewFrontmatter, parseFindingsFromMarkdown, mergeFollowup, renderReviewMarkdown } from './lib.mjs';
import { loadMethod } from './lib/method.mjs';
import { mergeRun } from './lib/merge.mjs';
import { upsertIndexEntry } from '../shared/stamp.mjs';
import { finishGate } from './gate.mjs';
import { findProjectRoot } from '../shared/lib.mjs';

const ROOT = findProjectRoot();
const MEMORY_DIR = join(ROOT, '.claude', 'memory');
const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

function fail(msg) {
  console.error(`[post-review] ${msg}`);
  process.exit(1);
}

// Strip only a real leading frontmatter block: on a file without one, the first body '---'
// separator would otherwise be taken for the delimiter and drop the header and first finding.
function stripFrontmatter(text) {
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
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}

const memFileFor = (date) => join(MEMORY_DIR, date.replace(/-/g, '/'), 'sharp-review.md');

function rescan(date) {
  const memFile = memFileFor(date);
  if (!existsSync(memFile)) fail(`No review file for ${date}: ${memFile}`);
  const content = readFileSync(memFile, 'utf8');
  const findings = parseFindingsFromMarkdown(content, date);
  if (!findings.length) {
    console.log(`[post-review] No findings found in ${memFile}`);
    return;
  }
  atomicWrite(memFile, `${reviewFrontmatter(findings, date)}\n${stripFrontmatter(content)}`);
  const open = findings.filter((f) => f.status !== 'fixed' && f.status !== 'FIXED').length;
  console.log(`[post-review] Rescanned: ${findings.length} findings, ${open} open`);
}

function writeMemory(output, plan, method) {
  const { date } = plan;
  const memFile = memFileFor(date);
  let findings = output.findings;
  let markdown = renderReviewMarkdown(output, { date, labels: plan.profiles.map((p) => p.label) });
  if (existsSync(memFile)) {
    const existing = readFileSync(memFile, 'utf8');
    const merged = mergeFollowup(parseFindingsFromMarkdown(existing, date), findings, markdown);
    findings = merged.findings;
    markdown = stripFrontmatter(existing) + `\n\n## Review ${date} (follow-up)\n\n` + merged.markdown;
  }
  mkdirSync(join(MEMORY_DIR, date.replace(/-/g, '/')), { recursive: true });
  atomicWrite(memFile, `${reviewFrontmatter(findings, date)}\n\n${markdown}`);
  try {
    upsertIndexEntry(ROOT, `${date.replace(/-/g, '/')}/sharp-review.md`, { name: `sharp-review-${date}`, date });
  } catch (e) {
    console.error(`[post-review] index stamp failed: ${e.message}`);
  }
  const high = output.findings.filter((f) => f.confidence === method.merge.confidence[0].label).length;
  console.log(`Sharp review: ${output.findings.length} issues (${high} high-confidence) → .claude/memory/${date.replace(/-/g, '/')}/sharp-review.md`);
}

if (arg('--release-gate')) {
  finishGate(ROOT, arg('--release-gate'), false);
} else if (args.includes('--rescan')) {
  const date = arg('--date');
  if (!date) fail('--rescan needs --date <YYYY-MM-DD>');
  rescan(date);
} else {
  const planFile = arg('--plan');
  const rawFile = arg('--raw');
  if (!planFile || !existsSync(planFile)) fail(`--plan <plan.json> is required and must exist: ${planFile}`);
  if (!rawFile || !existsSync(rawFile)) fail(`--raw <raw.json> is required and must exist: ${rawFile}`);
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
  // A raw file from an earlier run (a stale TEMP leftover) must never be merged as this one's.
  if (raw.run_id !== plan.run_id) fail(`raw.json belongs to run ${raw.run_id}, not run ${plan.run_id}`);
  if (statSync(rawFile).mtimeMs < Date.parse(plan.started_at)) fail(`raw.json (${rawFile}) is older than the run it claims (${plan.started_at})`);
  const method = loadMethod();
  const output = mergeRun({ range: plan.range, date: plan.date, profiles: plan.profiles.map((p) => p.key), reviewers: plan.reviewers, results: raw.results }, method);
  const sink = arg('--sink') || plan.sink;
  if (sink === 'memory') writeMemory(output, plan, method);
  else if (sink === 'stdout') process.stdout.write(JSON.stringify(output) + '\n');
  else fail(`unknown sink ${sink}; known: memory, stdout`);
  finishGate(ROOT, plan.gate_token, output.reviewers.some(reviewer => reviewer.status === 'ok'));
}
