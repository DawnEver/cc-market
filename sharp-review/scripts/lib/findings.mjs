// findings.mjs — the memory sink: render a findings JSON (merge.mjs output) as the
// sharp-review.md body, and renumber a same-day follow-up. Re-exported via lib.mjs.

// ── Same-day follow-up merge ──
// Every run numbers its findings from 001, so a second same-day review collides with the
// first run's SR-YYYYMMDD-NNN ids. Renumber the WHOLE incoming block contiguously after the
// existing max sequence (a per-collision renumber is unsafe: a shifted id can clash with an
// unshifted incoming one), rewriting the ids in the incoming markdown in one pass.
export function mergeFollowup(existingFindings, incomingFindings, incomingMarkdown) {
  const seqOf = (id) => {
    const m = /-(\d+)$/.exec(id || '');
    return m ? parseInt(m[1], 10) : 0;
  };
  let maxSeq = existingFindings.reduce((mx, f) => Math.max(mx, seqOf(f.id)), 0);
  const idMap = {};
  const renumbered = incomingFindings.map((f) => {
    if (!f.id) return f;
    const newId = f.id.replace(/-(\d+)$/, '-' + String(++maxSeq).padStart(3, '0'));
    if (newId !== f.id) idMap[f.id] = newId;
    return { ...f, id: newId };
  });
  let markdown = incomingMarkdown;
  const olds = Object.keys(idMap);
  if (olds.length) {
    // One regex alternation, one pass: a new id equal to another old id cannot cascade.
    const re = new RegExp(olds.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    markdown = incomingMarkdown.replace(re, (m) => idMap[m] || m);
  }
  return { findings: [...existingFindings, ...renumbered], markdown, renumbered: olds.length };
}

// ── Markdown render of one findings JSON ──
// `labels` are the run's profile labels (joined into the heading); `date` is YYYY-MM-DD.
export function renderReviewMarkdown(output, { date, labels = [] }) {
  const ran = output.reviewers.filter((r) => r.status !== 'skipped');
  const ok = ran.filter((r) => r.status === 'ok').length;
  const lines = [`## Review ${date} (session) — ${labels.join(' + ') || output.range}`, '', '### Reviewer Status'];
  for (const r of output.reviewers) lines.push(`- Reviewer ${r.name} (${r.provider ?? 'none'}): ${r.status}`);
  if (ok < ran.length) lines.push(`- Warning: only ${ok}/${ran.length} reviewers succeeded`);
  // Findings by the principle they violate (method principles.json ids); absent when none is tagged.
  const byPrinciple = new Map();
  for (const f of output.findings) for (const p of f.principles ?? []) byPrinciple.set(p, [...(byPrinciple.get(p) ?? []), f.id]);
  if (byPrinciple.size) {
    lines.push('', '### By principle', '');
    for (const p of [...byPrinciple.keys()].sort()) lines.push(`- ${p}: ${byPrinciple.get(p).join(', ')}`);
  }
  lines.push('', '### Confirmed findings', '');
  for (const f of output.findings) {
    lines.push('---', '', `### [${f.id}] [${f.severity}] ${f.file} — ${f.summary}`, '');
    lines.push(`- **Category:** ${f.category}`);
    lines.push(`- **Status:** ${f.status}`);
    lines.push(`- **Confidence:** ${f.confidence}`);
    lines.push(`- **Reviewers:** ${f.reviewers.map((r) => `${r.name} (${r.provider})`).join(', ')}`);
    if (f.principles?.length) lines.push(`- **Principles:** ${f.principles.join(', ')}`);
    if (f.suggestion) lines.push(`- **Suggestion:** ${f.suggestion}`);
    if (f.detail) lines.push('', f.detail);
    lines.push('');
  }
  return lines.join('\n');
}
