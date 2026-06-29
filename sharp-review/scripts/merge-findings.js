#!/usr/bin/env node
// merge-findings.js — merge raw per-reviewer findings and print the result to stdout.
//
// The external seam for content-review callers (e.g. ai-post 三方会审): fan out your
// own reviewers however you like (takeover call_model, etc.), collect each reviewer's
// raw { findings: [...] }, and hand them here. This reuses the SAME merge/dedup/
// confidence engine as `post-review.js --raw` (shared `lib.mjs`) but writes NO memory
// entry — it just prints { reviewFile, markdown, merged, summary } as JSON so the
// caller owns persistence.
//
// Usage:
//   node merge-findings.js --raw <raw.json> --date <YYYY-MM-DD>
//
// raw.json shape (rawResults positionally aligned with `active`):
//   { rawResults: [{ findings: [...] } | null, ...], reviewers, active,
//     profileLabel?, dedupKeyFields?, idPrefix? }

import { readFileSync, existsSync } from 'fs';
import { mergeFindings, renderReviewMarkdown } from './lib.mjs';

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const args = process.argv.slice(2);
const date = getArg(args, '--date');
const rawFile = getArg(args, '--raw');

if (!date) {
  console.error('[merge-findings] --date <YYYY-MM-DD> is required');
  process.exit(1);
}
if (!rawFile || !existsSync(rawFile)) {
  console.error(`[merge-findings] --raw <json-file> is required and must exist: ${rawFile}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
const rawResults = raw.rawResults || [];
const reviewers = raw.reviewers || [];
const active = raw.active || reviewers;
const slotResults = {};
active.forEach((r, i) => { slotResults[r.key] = rawResults[i]; });

const merged = mergeFindings(rawResults, { dedupKeyFields: raw.dedupKeyFields, idPrefix: raw.idPrefix, date });
const { markdown, reviewFile } = renderReviewMarkdown(merged, { reviewers, slotResults, active, date, profileLabel: raw.profileLabel });
const high = merged.filter((f) => f.confidence.includes('high')).length;

process.stdout.write(JSON.stringify({
  reviewFile,
  markdown,
  merged,
  summary: `${merged.length} issues (${high} high-confidence) → ${reviewFile}`,
}));
