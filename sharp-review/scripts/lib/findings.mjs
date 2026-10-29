// findings.mjs — the report sink: render a findings JSON (ai-lab merge output, findings v3) as the
// sharp-review.md body, and fold a same-day follow-up into it. Re-exported via lib.mjs.

// ── Same-day follow-up merge ──
// Findings v3 ids are STABLE (`F-<12 hex>` of rule, file and anchor line): a follow-up that reports a
// finding the day's report already holds names the same id, so it is not appended again. Returns every
// finding once (existing first), the incoming ones the report did not hold (`fresh`), and the ids it did
// (`repeated`).
export function mergeFollowup(existingFindings, incomingFindings) {
  const held = new Set(existingFindings.map((f) => f.id));
  const fresh = incomingFindings.filter((f) => !held.has(f.id));
  const repeated = incomingFindings.filter((f) => held.has(f.id)).map((f) => f.id);
  return { findings: [...existingFindings, ...fresh], fresh, repeated };
}

// ── Markdown render of one findings JSON ──
// `labels` are the run's profile labels (joined into the heading); `date` is YYYY-MM-DD. Every finding is
// tagged: severity, security, and the one rule id (a principle or a family registry rule) it violates.
export function renderReviewMarkdown(output, { date, labels = [] }) {
  const ran = output.reviewers.filter((r) => r.status !== 'skipped');
  const ok = ran.filter((r) => r.status === 'ok').length;
  const lines = [`## Review ${date} (session) — ${labels.join(' + ') || output.range}`, '', '### Reviewer Status'];
  for (const r of output.reviewers) lines.push(`- Reviewer ${r.name} (${r.provider ?? 'none'}): ${r.status}`);
  if (ok < ran.length) lines.push(`- Warning: only ${ok}/${ran.length} reviewers succeeded`);
  const blocking = output.findings.filter((f) => f.severity === 'HIGH' || f.security);
  if (blocking.length) lines.push('', `### Blocking (HIGH or security): ${blocking.map((f) => f.id).join(', ')}`);
  const byRule = new Map();
  for (const f of output.findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f.id]);
  if (byRule.size) {
    lines.push('', '### By rule', '');
    for (const r of [...byRule.keys()].sort()) lines.push(`- ${r}: ${byRule.get(r).join(', ')}`);
  }
  lines.push('', '### Confirmed findings', '');
  for (const f of output.findings) {
    lines.push('---', '', `### [${f.id}] [${f.severity}] ${f.file} — ${f.summary}`, '');
    lines.push(`- **Rule:** ${f.rule}`);
    lines.push(`- **Security:** ${f.security ? 'yes' : 'no'}`);
    lines.push(`- **Anchor:** \`${f.anchor}\``);
    lines.push(`- **Category:** ${f.category}`);
    lines.push(`- **Status:** ${f.status}`);
    lines.push(`- **Confidence:** ${f.confidence}`);
    lines.push(`- **Reviewers:** ${f.reviewers.map((r) => `${r.name} (${r.provider})`).join(', ')}`);
    if (f.suggestion) lines.push(`- **Suggestion:** ${f.suggestion}`);
    if (f.detail) lines.push('', f.detail);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Dispositions travel with the commit ──
// A finding disposed in the session (fixed elsewhere, intended, a false positive) is recorded as a commit
// trailer the forge PR review reads back and passes to the engine as disposed: one line per finding id.
export const DISPOSED_TRAILER = 'Review-Disposed';
const FINDING_ID_RE = /^F-[0-9a-f]{12}$/;
const DISPOSED_LINE_RE = new RegExp(`^${DISPOSED_TRAILER}: (F-[0-9a-f]{12}) -- (.+)$`, 'gm');

export function disposedTrailer(id, reason) {
  if (!FINDING_ID_RE.test(id)) throw new Error(`not an engine finding id: ${id} (F-<12 hex>)`);
  const text = String(reason ?? '').trim();
  if (!text) throw new Error(`a disposition of ${id} needs a reason`);
  if (/[\r\n]/.test(text)) throw new Error('a disposition reason is one line');
  return `${DISPOSED_TRAILER}: ${id} -- ${text}`;
}

export function parseDisposedTrailers(message) {
  return [...message.matchAll(DISPOSED_LINE_RE)].map(([, id, reason]) => ({ id, reason: reason.trim() }));
}
