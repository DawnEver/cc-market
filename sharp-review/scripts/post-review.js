#!/usr/bin/env node
// post-review.js — finish a planned run: merge the reviewers' raw results by the method's rules
// (ai-lab's `python -m ai_lab.review.merge`, via lib/ai-lab.mjs; sharp-review keeps no merge)
// and write one sink: `report` (the plan's `report` path under the project root: ai-lab's
// report_path, output/logs/<yy>/<mm>/<dd>/sharp-review/sharp-review.md -- regenerable output, never
// memory; a finding worth keeping is moved into memory by a person) or `stdout` (the findings JSON, ai-lab's findings-output.schema.json). Default: the plan's sink.
//
//   node post-review.js --plan <plan.json> --raw <raw.json> [--sink report|stdout] [--principles <principles.json>]
//     --principles overrides the project's principles (lib/ai-lab.mjs projectPrinciples)
//   node post-review.js --rescan --date <YYYY-MM-DD> --file <review.md>   re-derive frontmatter after an edit
//
// raw.json: { run_id, results: [{ name, findings? | text? | error_kind?, error? }] } — `name` is the
// plan's reviewer name; see skills/sharp-review/reference/direct-fanout.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { reviewFrontmatter, parseFindingsFromMarkdown, mergeFollowup, renderReviewMarkdown } from './lib.mjs';
import { mergeRun, AiLabUnavailable } from './lib/ai-lab.mjs';
import { finishGate } from './gate.mjs';
import { findProjectRoot } from '../shared/lib.mjs';

const ROOT = findProjectRoot();
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

function rescan(date, reportFile) {
  if (!existsSync(reportFile)) fail(`No review file for ${date}: ${reportFile}`);
  const content = readFileSync(reportFile, 'utf8');
  const findings = parseFindingsFromMarkdown(content, date);
  if (!findings.length) {
    console.log(`[post-review] No findings found in ${reportFile}`);
    return;
  }
  atomicWrite(reportFile, `${reviewFrontmatter(findings, date)}\n${stripFrontmatter(content)}`);
  const open = findings.filter((f) => f.status !== 'fixed' && f.status !== 'FIXED').length;
  console.log(`[post-review] Rescanned: ${findings.length} findings, ${open} open`);
}

function writeReport(output, plan) {
  const { date } = plan;
  if (!plan.report) fail('the plan names no report path; upgrade ai-lab (ai_lab.review.plan emits `report`)');
  const reportFile = join(ROOT, plan.report);
  const labels = plan.profiles.map((p) => p.label);
  let findings = output.findings;
  let markdown = renderReviewMarkdown(output, { date, labels });
  if (existsSync(reportFile)) {
    const existing = readFileSync(reportFile, 'utf8');
    const merged = mergeFollowup(parseFindingsFromMarkdown(existing, date), findings);
    findings = merged.findings;
    const again = merged.repeated.length ? `Reported again (same id, above): ${merged.repeated.join(', ')}\n\n` : '';
    const body = renderReviewMarkdown({ ...output, findings: merged.fresh }, { date, labels });
    markdown = stripFrontmatter(existing) + `\n\n## Review ${date} (follow-up)\n\n` + again + body;
  }
  mkdirSync(dirname(reportFile), { recursive: true });
  atomicWrite(reportFile, `${reviewFrontmatter(findings, date)}\n\n${markdown}`);
  const high = output.findings.filter((f) => f.confidence === plan.high_confidence).length;
  console.log(`Sharp review: ${output.findings.length} issues (${high} high-confidence) → ${plan.report}`);
}

if (arg('--release-gate')) {
  finishGate(ROOT, arg('--release-gate'), false);
} else if (args.includes('--rescan')) {
  const date = arg('--date');
  const file = arg('--file');
  if (!date || !file) fail('--rescan needs --date <YYYY-MM-DD> --file <review.md>');
  rescan(date, file);
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
  let output;
  try {
    output = mergeRun({ range: plan.range, profiles: plan.profiles.map((p) => p.key), reviewers: plan.reviewers, results: raw.results },
      arg('--principles') ? { principles: arg('--principles') } : {});
  } catch (e) {
    if (e instanceof AiLabUnavailable) fail(`${e.name}: ${e.message}`);
    throw e;
  }
  const sink = arg('--sink') || plan.sink;
  if (sink === 'report') writeReport(output, plan);
  else if (sink === 'stdout') process.stdout.write(JSON.stringify(output) + '\n');
  else fail(`unknown sink ${sink}; known: report, stdout`);
  finishGate(ROOT, plan.gate_token, sink === 'report' && output.reviewers.some(reviewer => reviewer.status === 'ok'));
}
