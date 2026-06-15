export const meta = {
  name: 'sharp-review',
  description: 'Post-feature sharp review — 2 parallel reviewers (random pick from 3 backends), merge findings, sync task list',
  phases: [
    { title: 'Review', detail: '2 parallel reviewers with schema' },
    { title: 'Merge', detail: 'cross-check, assign IDs, render markdown' },
    { title: 'Sync', detail: 'return structured findings' },
  ],
};

// ── Default Finding Schema (code review) ──

const DEFAULT_FINDING = {
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

// ── Default Reviewers (code review) ──

const DEFAULT_REVIEWERS = [
  { key: 'A', name: 'Codex', provider: 'codex' },
  { key: 'B', name: 'DeepSeek', provider: 'deepseek' },
  { key: 'C', name: 'Sonnet', provider: 'claude', model: 'sonnet' },
];

// ── Default Review Scope (code review) ──

const DEFAULT_REVIEW_SCOPE = [
  'Bad architectural or design decisions',
  'Redundant / dead code',
  'Anything simpler, faster, or more idiomatic',
  'Missed edge cases or silent failures',
  'Files that grew past ~400 lines and should be split into smaller modules',
].join(', ');

// ── Default Dedup Key Fields ──

const DEFAULT_DEDUP_KEY_FIELDS = ['file', 'summary'];

// ── Helpers ──

function buildFindingsFormat(findingSchema) {
  const props = findingSchema.properties || {};
  const lines = ['Each finding has these fields:'];
  for (const [name, def] of Object.entries(props)) {
    const desc = def.description || '';
    if (def.enum) {
      lines.push(`- ${name}: ${def.enum.map(v => `"${v}"`).join(' | ')}${desc ? ' — ' + desc : ''}`);
    } else if (def.type) {
      lines.push(`- ${name}: ${def.type}${desc ? ' — ' + desc : ''}`);
    }
  }
  lines.push('');
  lines.push('If there are no issues, call StructuredOutput with { "findings": [] }.');
  return lines.join('\n');
}

const ID_PREFIX = 'SR';

function buildFindingsSchema(findingSchema) {
  return {
    type: 'object',
    properties: {
      findings: { type: 'array', items: findingSchema },
    },
    required: ['findings'],
  };
}

function buildDedupKey(f, fields) {
  return fields.map(field => (f[field] || '').toString().toLowerCase().slice(0, 60)).join('|');
}

// ── Content review prompt ──

function buildContentReviewPrompt(reviewer, args) {
  const scope = args.reviewScope || DEFAULT_REVIEW_SCOPE;
  const findingsFormat = buildFindingsFormat(args.findingSchema || DEFAULT_FINDING);

  const reviewBody = `Review the following content. Be BLUNT. Praise nothing that doesn't deserve it.

Scope: ${scope}

Respond with ONLY a JSON object: { "findings": [...] }
${findingsFormat}

Content to review:
\`\`\`
${args.content}
\`\`\``;

  const provider = reviewer.provider || 'claude';
  const modelArg = reviewer.model ? `, model="${reviewer.model}"` : '';

  return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="${provider}"${modelArg}, mode="review" and a userPrompt containing:

${reviewBody}

Then take the response and call the StructuredOutput tool with it.

If the takeover tool call fails, call StructuredOutput with { "findings": [] }.`;
}

// ── Code review prompt (original behavior, parameterized) ──

// Wrap a prepared review body into the per-reviewer takeover call. Provider/model routing
// stays decoupled from the profile: A→codex, B→deepseek, C→sonnet (or the reviewer's own).
function wrapTakeoverCall(reviewer, takeoverMode, body, findingsFormat) {
  if (reviewer.key === 'A') {
    return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="codex", mode="${takeoverMode}", and userPrompt set to:

${body}

Then translate the findings into the required JSON schema and call the StructuredOutput tool with a JSON object: { "findings": [...] }
${findingsFormat}

If the takeover tool call fails or Codex is unavailable, call StructuredOutput with { "findings": [] }.`;
  }

  const provider = reviewer.provider || (reviewer.key === 'B' ? 'deepseek' : 'claude');
  const modelArg = reviewer.model ? `, model="${reviewer.model}"` : (reviewer.key === 'C' ? ', model="sonnet"' : '');

  return `Use the mcp__plugin_takeover_takeover__call_model tool with provider="${provider}"${modelArg}, mode="${takeoverMode}" and a userPrompt containing:

${body}

Then take the response and call the StructuredOutput tool with it.

If the takeover tool call fails, call StructuredOutput with { "findings": [] }.`;
}

function buildCodeReviewPrompt(reviewer, args) {
  const scope = args.reviewScope || DEFAULT_REVIEW_SCOPE;
  const findingsFormat = buildFindingsFormat(args.findingSchema || DEFAULT_FINDING);
  const prefix = `Range: ${args.range}.${args.path ? ` Scope: ${args.path}.` : ''} ${args.excludedSummary || ''}`;

  // Architecture profile: holistic survey, no diff/manifest. Reviewers explore the repo freely.
  if (args.promptKind === 'architecture') {
    const archBody = `${args.framing || 'Survey the current codebase architecture as a whole.'}

## Your job — explore autonomously
- You have full tool access. Walk the repo: read the directory structure, entry points, build/config
  files, and the main modules. Trace how the pieces fit together before judging.
- Assess the architecture as it stands today — do NOT focus on any single diff or recent change.
- Be BLUNT. Report concrete weaknesses with the file/dir they live in, and a one-line improvement each.

Scope: ${scope}

Respond with ONLY a JSON object: { "findings": [...] }
${findingsFormat}`;
    return wrapTakeoverCall(reviewer, 'agent', archBody, findingsFormat);
  }

  const intro = args.framing ? `${args.framing}\n\n` : '';

  if (args.mode === 'review') {
    const reviewBody = `${intro}${prefix}

Review the following git diff. Be BLUNT. Praise nothing that doesn't deserve it.

Scope: ${scope}

Respond with ONLY a JSON object: { "findings": [...] }
${findingsFormat}

Git diff:
\`\`\`
${args.diff}
\`\`\``;
    return wrapTakeoverCall(reviewer, 'review', reviewBody, findingsFormat);
  }

  // Agent mode: manifest + autonomous exploration
  const agentBody = `${intro}Large change set (${args.stats.files} files, +${args.stats.insertions}/-${args.stats.deletions}). Full diff NOT included.
${prefix}

## Review manifest (all changed files)
${args.manifestText}

## Your job — explore autonomously
- You have full tool access. Run \`git diff ${args.range} -- <path>\` to read any file's changes;
  read source files / trace callers as needed.
- Cover ALL manifest files at least at summary level; deep-read the ones that matter,
  prioritized by (1) churn, (2) risk (core logic, auth/security, error handling, concurrency),
  (3) new files (status A). Skip tests/docs/config unless the manifest looks suspicious.
- Scope: ${scope}
- Respond with ONLY a JSON object: { "findings": [...] }  ${findingsFormat}`;
  return wrapTakeoverCall(reviewer, 'agent', agentBody, findingsFormat);
}

// ── Main ──

// Normalize args: tolerate a JSON-encoded string payload. Some Workflow callers pass
// `args` as a stringified object instead of a real JSON value, which silently strips
// every field (args.stats → undefined) and dead-ends the run. Parse it back here.
const A = typeof args === 'string' ? JSON.parse(args) : (args || {});

// Single defensive fallback date. The caller always passes A.date, so this only
// matters when it is missing — keep one constant rather than scattering literals.
const date = A.date || '2026-06-04';

// Resolve config with fallbacks
const contentType = A.contentType || 'code';
const findingSchema = A.findingSchema || DEFAULT_FINDING;
const findingsSchema = buildFindingsSchema(findingSchema);
const reviewers = A.reviewers || DEFAULT_REVIEWERS;
const pickStrategy = A.pickStrategy || 'seed-mod';
const dedupKeyFields = A.dedupKeyFields || DEFAULT_DEDUP_KEY_FIELDS;

// Validate required args
if (contentType === 'code') {
  if (!A.stats || typeof A.stats.files !== 'number') {
    const err = `sharp-review-workflow: args.stats is required for code mode (got ${JSON.stringify(A.stats)}). The caller must pass diff-manifest.js output fields verbatim (as a JSON object, not a stringified one).`;
    log(err);
    return { error: 'missing-stats', reason: err };
  }
} else if (contentType === 'content') {
  if (!A.content || typeof A.content !== 'string' || A.content.trim().length === 0) {
    const err = `sharp-review-workflow: args.content is required for content mode (got ${typeof A.content}).`;
    log(err);
    return { error: 'missing-content', reason: err };
  }
}

// ── Phase 1: Review ──

phase('Review');

// Pick reviewers based on strategy
let active;
if (pickStrategy === 'all') {
  active = [...reviewers];
} else {
  // seed-mod: pick 2 of N from a time-based seed (minutes since epoch,
  // supplied by diff-manifest.js) so multiple rounds in one day rotate the
  // pair, not just day-to-day. Falls back to day-of-month if no seed given.
  const seed = Number.isFinite(A.seed)
    ? A.seed
    : (parseInt(date.slice(-2), 10) || 9);
  const n = reviewers.length;
  if (n <= 2) {
    active = [...reviewers];
  } else {
    // Cycle through all pair combinations: (0,1), (1,2), (2,0), (0,1), ...
    const comboCount = n * (n - 1) / 2;
    const comboIdx = seed % comboCount;
    // Generate the comboIdx-th pair
    let ci = 0;
    active = [];
    for (let i = 0; i < n && active.length < 2; i++) {
      for (let j = i + 1; j < n && active.length < 2; j++) {
        if (ci === comboIdx) { active = [reviewers[i], reviewers[j]]; }
        ci++;
      }
    }
  }
}

// Build prompt per reviewer
const promptBuilder = contentType === 'content' ? buildContentReviewPrompt : buildCodeReviewPrompt;

if (contentType === 'code') {
  log(`Mode: ${A.mode} | Range: ${A.range}${A.path ? ` | Scope: ${A.path}` : ''} | ${A.stats.files} files, +${A.stats.insertions}/-${A.stats.deletions} | ${A.excludedSummary || 'no files excluded'}`);
} else {
  log(`Content review mode | ${active.length} reviewers | ${A.content.length} chars of content`);
}
log(`Launching ${active.length} parallel reviewers (${active.map(r => r.name).join(' + ')})...`);

const raw = await parallel(active.map(r => () =>
  agent(
    promptBuilder(r, A),
    { label: `Reviewer ${r.key} (${r.name})`, phase: 'Review', schema: findingsSchema }
  )
)).catch(() => active.map(() => null));

const results = raw.filter(Boolean);
const succeeded = results.filter(r => r && Array.isArray(r.findings));
log(`${succeeded.length}/${active.length} reviewers returned results`);

// Map results back to reviewer keys for markdown rendering
const slotResults = {};
active.forEach((r, i) => { slotResults[r.key] = raw[i]; });

// ── Phase 2: Merge ──

phase('Merge');

// Collect all findings
const allFindings = [];
for (const result of results) {
  if (result && Array.isArray(result.findings)) allFindings.push(...result.findings);
}

// Deduplicate by configurable key fields
const grouped = new Map();
for (const f of allFindings) {
  const k = buildDedupKey(f, dedupKeyFields);
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(f);
}

const today = date.replace(/-/g, '');
const idPrefix = A.idPrefix || ID_PREFIX;
const merged = [];
let seq = 0;

for (const [k, group] of grouped) {
  seq++;
  const id = `${idPrefix}-${today}-${String(seq).padStart(3, '0')}`;
  const primary = group[0];
  const confidence = group.length >= 2 ? 'high-confidence (≥2 reviewers)' : 'single-reviewer';
  merged.push({
    id,
    severity: primary.severity || 'MEDIUM',
    file: primary.file || '',
    summary: primary.summary || '',
    category: primary.category || 'Bug',
    status: primary.status || 'OPEN',
    suggestion: primary.suggestion || '',
    detail: primary.detail || '',
    confidence,
  });
}

log(`${merged.length} unique findings (${merged.filter(f => f.confidence.includes('high')).length} high-confidence)`);

// ── Render markdown ──

const dateStr = date;
const timestamp = dateStr + ' (session)';
const reviewFile = `.claude/memory/${dateStr.replace(/-/g, '/')}/sharp-review.md`;

const lines = [];
lines.push(`## Review ${timestamp} — ${A.profileLabel || 'current branch'}`);
lines.push('');
lines.push('### Reviewer Status');
for (const r of reviewers) {
  const status = Array.isArray(slotResults[r.key]?.findings) ? 'OK' : (active.some(a => a.key === r.key) ? 'FAILED' : 'skipped');
  lines.push(`- Reviewer ${r.key} (${r.name}): ${status}`);
}
if (succeeded.length < active.length) lines.push(`- Warning: only ${succeeded.length}/${active.length} reviewers succeeded`);
lines.push('');
lines.push('### Confirmed findings');
lines.push('');

for (const f of merged) {
  lines.push('---');
  lines.push('');
  lines.push(`### [${f.id}] [${f.severity}] ${f.file} — ${f.summary}`);
  lines.push('');
  lines.push(`- **Category:** ${f.category}`);
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

// ── Phase 3: Sync ──

phase('Sync');

return {
  reviewFile,
  markdown,
  merged,
  summary: `${merged.length} issues (${merged.filter(f => f.confidence.includes('high')).length} high-confidence) → ${reviewFile}`,
};
