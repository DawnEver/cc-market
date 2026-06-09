// lib.mjs — Sharp Review shared library
// Constants, helpers, and memory cross-reference logic

// ── Constants ──

export const SR_ID_RE = /SR-\d{8}-\d{3}/g;
export const SR_ID_PARSE_RE = /^SR-(\d{8})-(\d{3})$/;
export const FINDING_HDR_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
export const STATUS_RE = /^\s*-?\s*\*\*Status:\*\*\s*(\w+)/m;

// ── Date helpers (no Date.now() — callers pass explicit date) ──

export function todayISO(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === 'string') return date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

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

// ── Review Frontmatter ──

export function reviewFrontmatter(findings, date) {
  const count = Array.isArray(findings) ? findings.length : 0;
  const desc = `Sharp review findings — ${count} total`;
  return [
    '---',
    `name: sharp-review-${date}`,
    `description: ${desc}`,
    'metadata:',
    '  type: project',
    `created: ${date}`,
    `accessed: ${date}`,
    'tier: short',
    '---',
  ].join('\n');
}

// ── Markdown parsing ──

export function parseFindingsFromMarkdown(content, date) {
  const findings = [];
  const blocks = content.split(/\n(?=###\s+\[SR-)/);
  for (const block of blocks) {
    const hdr = block.match(FINDING_HDR_RE);
    if (!hdr) continue;
    const statusMatch = block.match(STATUS_RE);
    const status = statusMatch ? statusMatch[1].toLowerCase() : 'open';
    const resolvedDate = status === 'fixed' ? date : null;
    const file = hdr[3].trim();
    const moduleMatch = block.match(/^\s*-?\s*\*\*Module:\*\*\s*(.+)/m);
    findings.push({
      id: hdr[1],
      severity: hdr[2],
      file,
      summary: hdr[4].trim(),
      status,
      discovered: hdr[1].slice(3, 11).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      resolvedDate,
      category: 'Bug',
      module: moduleMatch ? moduleMatch[1].trim() : '',
      suggestion: '',
      detail: '',
    });
  }
  return findings;
}
