export const meta = {
  name: 'sharp-review',
  description: 'Post-feature sharp review — 3 parallel reviewers with schema, merge findings, sync task list',
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
    module: { description: 'Module name inferred from file path', type: 'string' },
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
].join(', ');

function reviewPrompt(diff) {
  return `Review the following git diff. Be BLUNT. Praise nothing that doesn't deserve it.

Scope: ${REVIEW_SCOPE}

You MUST call the StructuredOutput tool with a JSON object: { "findings": [...] }
Each finding has these fields:
- severity: "HIGH" | "MEDIUM" | "LOW" | "INFO"
- file: affected file path relative to repo root (string)
- summary: one-line description of the issue (string)
- category: "Bug" | "Feature" | "Performance"
- module: inferred from file path (e.g. "notify hook")
- status: "OPEN" | "FIXED"
- suggestion: one-line fix (string)
- detail: optional deeper analysis (string)

If there are no issues, call StructuredOutput with { "findings": [] }.

Git diff:
\`\`\`
${diff}
\`\`\``;
}

// ── Phase 1: Review ──

phase('Review');

log('Launching 3 parallel reviewers (Codex adversarial-review + DeepSeek + Claude)...');

const reviewers = await parallel([
  // Reviewer A — Claude (adversarial)
  () => agent(
    reviewPrompt(args.diff || 'See git diff in context above'),
    { label: 'Reviewer A', phase: 'Review', schema: FINDINGS_SCHEMA }
  ),
  // Reviewer B — Claude (independent)
  () => agent(
    reviewPrompt(args.diff || 'See git diff in context above'),
    { label: 'Reviewer B', phase: 'Review', schema: FINDINGS_SCHEMA }
  ),
  // Reviewer C — Claude (independent)
  () => agent(
    reviewPrompt(args.diff || 'See git diff in context above'),
    { label: 'Reviewer C', phase: 'Review', schema: FINDINGS_SCHEMA }
  ),
]).catch(() => [null, null, null]);

const results = reviewers.filter(Boolean);
const succeeded = results.filter(r => r && Array.isArray(r.findings));
log(`${succeeded.length}/3 reviewers returned results`);

if (succeeded.length < 2) {
  log('WARNING: Fewer than 2 reviewers succeeded. Findings are single-source only.');
}

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
const sharpReviewDir = '.claude/sharp-review';
const reviewFile = `${sharpReviewDir}/${dateStr}.md`;

const lines = [];
lines.push(`## Review ${timestamp} — current branch`);
lines.push('');
lines.push('### Reviewer Status');
lines.push(`- Reviewer A: ${results[0] ? 'OK' : 'FAILED'}`);
lines.push(`- Reviewer B: ${results[1] ? 'OK' : 'FAILED'}`);
lines.push(`- Reviewer C: ${results[2] ? 'OK' : 'FAILED'}`);
if (succeeded.length < 2) lines.push('- Self-review fallback: used to supplement');
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

// The parent skill will write the markdown and run sync-tasks.
// Return the structured data so the skill can do the I/O.

return {
  reviewFile,
  markdown,
  merged,
  summary: `${merged.length} issues (${merged.filter(f => f.confidence.includes('high')).length} high-confidence) → ${reviewFile}`,
};
