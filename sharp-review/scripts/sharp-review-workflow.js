export const meta = {
  name: 'sharp-review',
  description: 'Post-feature sharp review — 2 parallel reviewers (random pick from 3 backends), merge findings, sync task list',
  phases: [
    { title: 'Review', detail: '3 parallel reviewers with schema' },
    { title: 'Merge', detail: 'cross-check, assign IDs, render markdown' },
    { title: 'Sync', detail: 'return structured findings' },
  ],
};

// ── Finding Schema ──

const FINDING = {
  type: 'object',
  properties: {
    severity: { description: 'Severity level', enum: ['HIGH', 'MEDIUM', 'LOW', 'INFO'] },
    file: { description: 'Affected file path relative to repo root', type: 'string' },
    summary: { description: 'One-line issue description', type: 'string' },
    category: { description: 'Bug, Feature, or Performance', enum: ['Bug', 'Feature', 'Performance'] },
    status: { description: 'OPEN or FIXED if resolved inline', enum: ['OPEN', 'FIXED'] },
    suggestion: { description: 'One-line fix suggestion', type: 'string' },
    detail: { description: 'Optional deeper analysis', type: 'string' },
  },
  required: ['severity', 'summary', 'category'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: FINDING },
  },
  required: ['findings'],
};

// ── Review prompt template ──

const REVIEW_SCOPE = [
  'Bad architectural or design decisions',
  'Redundant / dead code',
  'Anything simpler, faster, or more idiomatic',
  'Missed edge cases or silent failures',
  'Files that grew past ~400 lines and should be split into smaller modules',
].join(', ');

const FINDINGS_FORMAT = `Each finding has these fields:
- severity: "HIGH" | "MEDIUM" | "LOW" | "INFO"
- file: affected file path relative to repo root (string)
- summary: one-line description of the issue (string)
- category: "Bug" | "Feature" | "Performance"
- status: "OPEN" | "FIXED"
- suggestion: one-line fix (string)
- detail: optional deeper analysis (string)

If there are no issues, call StructuredOutput with { "findings": [] }.`;

function reviewPrompt(diff) {
  return `Review the following git diff. Be BLUNT. Praise nothing that doesn't deserve it.

Scope: ${REVIEW_SCOPE}

You MUST call the StructuredOutput tool with a JSON object: { "findings": [...] }
${FINDINGS_FORMAT}

Git diff:
\`\`\`
${diff}
\`\`\``;
}

function codexReviewPrompt(diff) {
  return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="codex", mode="review", and userPrompt set to the git diff below — this runs Codex's adversarial review directly via its app-server, no plugin install required.

Then translate Codex's findings into the required JSON schema and call the StructuredOutput tool with a JSON object: { "findings": [...] }
${FINDINGS_FORMAT}

If the takeover tool call fails or Codex is unavailable, call StructuredOutput with { "findings": [] }.

Git diff:
\`\`\`
${diff}
\`\`\``;
}

function deepseekAgentPrompt(diff) {
  return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="deepseek", mode="review" and a userPrompt containing:

Review the following git diff. Explore the codebase as needed — read relevant source files, trace callers and callees, check for edge cases. Be BLUNT.

Scope: ${REVIEW_SCOPE}

Respond with ONLY a JSON object: { "findings": [...] }
${FINDINGS_FORMAT}

Git diff:
\`\`\`
${diff}
\`\`\`

Then take the response and call the StructuredOutput tool with it.

If the takeover tool call fails, call StructuredOutput with { "findings": [] }.`;
}

function claudeAgentPrompt(diff) {
  return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="claude", model="sonnet", mode="review" and a userPrompt containing:

Review the following git diff. Explore the codebase as needed — read relevant source files, trace callers and callees, check for edge cases. Be BLUNT.

Scope: ${REVIEW_SCOPE}

Respond with ONLY a JSON object: { "findings": [...] }
${FINDINGS_FORMAT}

Git diff:
\`\`\`
${diff}
\`\`\`

Then take the response and call the StructuredOutput tool with it.

If the takeover tool call fails, call StructuredOutput with { "findings": [] }.`;
}

// ── Phase 1: Review ──

phase('Review');

// Pick 2 of 3 reviewers deterministically from date (Math.random() banned in workflows).
// Day-of-month mod 3 cycles through combinations for diversity across sessions.
const reviewers = [
  { key: 'A', name: 'Codex', prompt: codexReviewPrompt },
  { key: 'B', name: 'DeepSeek', prompt: deepseekAgentPrompt },
  { key: 'C', name: 'Sonnet', prompt: claudeAgentPrompt },
];
const day = parseInt((args.date || '2026-06-09').slice(-2), 10) || 9;
const combos = [[0, 1], [1, 2], [0, 2]];  // AB, BC, AC
const pick = combos[day % 3];
const active = pick.map(i => reviewers[i]);

log(`Launching 2 parallel reviewers (${active.map(r => r.name).join(' + ')})...`);

const raw = await parallel(active.map(r => () =>
  agent(
    r.prompt(args.diff || 'See git diff in context above'),
    { label: `Reviewer ${r.key} (${r.name})`, phase: 'Review', schema: FINDINGS_SCHEMA }
  )
)).catch(() => [null, null]);

const results = raw.filter(Boolean);
const succeeded = results.filter(r => r && Array.isArray(r.findings));
log(`${succeeded.length}/2 reviewers returned results`);

// Map results back to A/B/C slots for markdown rendering
const slotResults = { A: null, B: null, C: null };
pick.forEach((ri, i) => { slotResults[reviewers[ri].key] = raw[i]; });

// ── Phase 3: Merge ──

phase('Merge');

// Collect all findings
const allFindings = [];
for (const result of results) {
  if (result && Array.isArray(result.findings)) allFindings.push(...result.findings);
}

// Deduplicate by summary similarity (≥2 reviewers = high confidence)
function key(f) {
  return (f.file || '').toLowerCase() + '|' + (f.summary || '').toLowerCase().slice(0, 60);
}

const grouped = new Map();
for (const f of allFindings) {
  const k = key(f);
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(f);
}

const today = (args.date || '2026-06-04').replace(/-/g, '');
const merged = [];
let seq = 0;

for (const [k, group] of grouped) {
  seq++;
  const id = `SR-${today}-${String(seq).padStart(3, '0')}`;
  const primary = group[0];
  const confidence = group.length >= 2 ? 'high-confidence (≥2 reviewers)' : 'single-reviewer';
  merged.push({
    id,
    severity: primary.severity || 'MEDIUM',
    file: primary.file || '',
    summary: primary.summary || '',
    category: primary.category || 'Bug',
    module: primary.module || '',
    status: primary.status || 'OPEN',
    suggestion: primary.suggestion || '',
    detail: primary.detail || '',
    confidence,
  });
}

log(`${merged.length} unique findings (${merged.filter(f => f.confidence.includes('high')).length} high-confidence)`);

// ── Render markdown ──

const dateStr = args.date || '2026-06-04';
const timestamp = dateStr + ' (session)';
const reviewFile = `.claude/memory/${dateStr.replace(/-/g, '/')}/sharp-review.md`;

const lines = [];
lines.push(`## Review ${timestamp} — current branch`);
lines.push('');
lines.push('### Reviewer Status');
const ran = pick.map(i => reviewers[i]);
lines.push(`- Reviewer A (Codex): ${slotResults.A ? 'OK' : (ran.some(r => r.key === 'A') ? 'FAILED' : 'skipped')}`);
lines.push(`- Reviewer B (DeepSeek): ${slotResults.B ? 'OK' : (ran.some(r => r.key === 'B') ? 'FAILED' : 'skipped')}`);
lines.push(`- Reviewer C (Sonnet): ${slotResults.C ? 'OK' : (ran.some(r => r.key === 'C') ? 'FAILED' : 'skipped')}`);
if (succeeded.length < 2) lines.push('- Warning: fewer than 2 reviewers succeeded');
lines.push('');
lines.push('### Confirmed findings');
lines.push('');

for (const f of merged) {
  lines.push('---');
  lines.push('');
  lines.push(`### [${f.id}] [${f.severity}] ${f.file} — ${f.summary}`);
  lines.push('');
  lines.push(`- **Category:** ${f.category}`);
  if (f.module) lines.push(`- **Module:** ${f.module}`);
  lines.push(`- **Status:** ${f.status}`);
  lines.push(`- **Confidence:** ${f.confidence}`);
  if (f.suggestion) lines.push(`- **Suggestion:** ${f.suggestion}`);
  if (f.detail) {
    lines.push('');
    lines.push(f.detail);
  }
  lines.push('');
}

const markdown = lines.join('\n');

// Write to file via Bash
log(`Writing findings to ${reviewFile}...`);

// ── Phase 4: Sync ──

phase('Sync');

// The parent skill will write the markdown via post-review.js.
// Return the structured data so the skill can do the I/O.

return {
  reviewFile,
  markdown,
  merged,
  summary: `${merged.length} issues (${merged.filter(f => f.confidence.includes('high')).length} high-confidence) → ${reviewFile}`,
};
