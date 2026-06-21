// findings.mjs — Sharp Review finding logic: category inference, same-day follow-up
// renumber, and host-agnostic merge + markdown render. Re-exported via lib.mjs.

// ── Category inference ──

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

// ── Same-day follow-up merge ──
// The workflow restarts finding sequence numbers at 001 every run, so a second
// same-day review (e.g. a diff review then an architecture review) collides with
// the first run's SR-YYYYMMDD-NNN ids. Renumber the colliding incoming findings to
// continue after the existing max sequence, and rewrite their ids in the incoming
// markdown in a single cascade-safe pass. Returns the merged findings + rewritten markdown.
export function mergeFollowup(existingFindings, incomingFindings, incomingMarkdown) {
  const seqOf = (id) => {
    const m = /-(\d+)$/.exec(id || '');
    return m ? parseInt(m[1], 10) : 0;
  };
  let maxSeq = existingFindings.reduce((mx, f) => Math.max(mx, seqOf(f.id)), 0);
  const idMap = {};
  // Renumber the WHOLE incoming block contiguously after the existing max sequence.
  // (A per-collision renumber is unsafe: a shifted id can clash with an un-shifted
  // incoming id.) Incoming always restarts at 001, so this just appends cleanly.
  const renumbered = incomingFindings.map((f) => {
    if (!f.id) return f;
    const newId = f.id.replace(/-(\d+)$/, '-' + String(++maxSeq).padStart(3, '0'));
    if (newId !== f.id) idMap[f.id] = newId;
    return { ...f, id: newId };
  });
  let markdown = incomingMarkdown;
  const olds = Object.keys(idMap);
  if (olds.length) {
    // Single regex alternation → one pass, so a new id that equals another old id
    // (when existing has fewer findings than incoming) can't cascade.
    const re = new RegExp(olds.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    markdown = incomingMarkdown.replace(re, (m) => idMap[m] || m);
  }
  return { findings: [...existingFindings, ...renumbered], markdown, renumbered: olds.length };
}

// ── Finding merge + render (host-agnostic) ──
//
// Extracted from the Claude Workflow VM script so BOTH hosts share one tested
// implementation: Claude's Workflow returns raw per-reviewer findings → post-review
// merges/renders; Codex fans out reviewers (spawn_agent / takeover call_model) → the
// same merge/render. The Workflow VM (sandboxed, no import) cannot call these — it
// passes raw results out to post-review.js, which can.

export const DEFAULT_DEDUP_KEY_FIELDS = ['file', 'summary'];
export const SR_ID_PREFIX = 'SR';

export function buildDedupKey(f, fields = DEFAULT_DEDUP_KEY_FIELDS) {
  return fields.map((field) => (f[field] || '').toString().toLowerCase().slice(0, 60)).join('|');
}

// Dedup raw findings across reviewers and assign sequential SR-YYYYMMDD-NNN ids.
// `rawResults` is an array of per-reviewer objects ({ findings: [...] } | null).
// `date` is YYYY-MM-DD (never derived here — caller passes it, mirroring the
// no-Date.now() workflow invariant).
export function mergeFindings(rawResults, { dedupKeyFields = DEFAULT_DEDUP_KEY_FIELDS, idPrefix = SR_ID_PREFIX, date } = {}) {
  const allFindings = [];
  for (const result of rawResults) {
    if (result && Array.isArray(result.findings)) allFindings.push(...result.findings);
  }

  const grouped = new Map();
  for (const f of allFindings) {
    const k = buildDedupKey(f, dedupKeyFields);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(f);
  }

  const today = (date || '').replace(/-/g, '');
  const merged = [];
  let seq = 0;
  for (const [, group] of grouped) {
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
  return merged;
}

// Render merged findings to the sharp-review markdown body + memory path.
// `reviewers` = all configured reviewers; `slotResults` = { key: rawResult|null };
// `active` = the reviewers actually run; `date` = YYYY-MM-DD.
export function renderReviewMarkdown(merged, { reviewers, slotResults = {}, active = [], date, profileLabel } = {}) {
  const succeeded = active.filter((r) => Array.isArray(slotResults[r.key]?.findings)).length;
  const reviewFile = `.claude/memory/${date.replace(/-/g, '/')}/sharp-review.md`;
  const lines = [];
  lines.push(`## Review ${date} (session) — ${profileLabel || 'current branch'}`);
  lines.push('');
  lines.push('### Reviewer Status');
  for (const r of reviewers) {
    const status = Array.isArray(slotResults[r.key]?.findings)
      ? 'OK'
      : (active.some((a) => a.key === r.key) ? 'FAILED' : 'skipped');
    lines.push(`- Reviewer ${r.key} (${r.name}): ${status}`);
  }
  if (succeeded < active.length) lines.push(`- Warning: only ${succeeded}/${active.length} reviewers succeeded`);
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
  return { markdown: lines.join('\n'), reviewFile };
}
