// lib.mjs — Sharp Review shared library
// Category inference, frontmatter, and markdown parsing.
// Regex and date helpers imported from cc-market/shared/.

import {
  SR_ID_RE, SR_ID_PARSE_RE,
  SR_FINDING_HDR_RE,
  SR_STATUS_RE,
  todayISO,
  reviewFrontmatter,
  parseFindingsFromMarkdown,
} from './shared/lib.mjs';

export {
  SR_ID_RE, SR_ID_PARSE_RE,
  SR_FINDING_HDR_RE as FINDING_HDR_RE,
  SR_STATUS_RE as STATUS_RE,
  todayISO,
  reviewFrontmatter,
  parseFindingsFromMarkdown,
};

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

// ── Review profiles ──
// A profile is a review *template* (scope, prompt framing, forced mode) — NOT bound to any
// provider. Provider/model selection stays the per-reviewer seed-mod rotation. Profiles are
// selected probabilistically per trigger (see pickProfileKey); weights are tunable per project
// via reviewGate.profileWeights in .claude/.rem-state.json.

export const PROFILES = {
  diff: {
    key: 'diff',
    label: 'diff review',
    weight: 0.8,            // default probability
    mode: null,             // null = honor diff-manifest's decided mode (review/agent/empty)
    promptKind: 'diff',
    framing: null,          // null = workflow's existing default intro
    reviewScope: null,      // null = DEFAULT_REVIEW_SCOPE in the workflow
  },
  architecture: {
    key: 'architecture',
    label: 'architecture survey (架构锐评)',
    weight: 0.2,
    mode: 'agent',          // forced — reviewers explore the repo freely
    promptKind: 'architecture',
    framing: '架构锐评: survey the CURRENT codebase architecture as a whole — this is NOT a diff review.',
    reviewScope: [
      'Module boundaries and layering violations',
      'Coupling / cohesion problems and circular dependencies',
      'Duplication and missing abstractions across the codebase',
      'Files/dirs that grew too large or hold too many responsibilities',
      'Inconsistent patterns, dead subsystems, scalability / extensibility limits',
    ].join(', '),
  },
};

export function resolveProfile(key) {
  return PROFILES[key] || PROFILES.diff;
}

// Merge a per-project weight override map over the registry defaults. Unknown keys ignored;
// non-positive / non-finite weights dropped. Returns { <key>: weight } for known profiles.
export function resolveWeights(override) {
  const weights = {};
  for (const [key, p] of Object.entries(PROFILES)) {
    const w = override && Number.isFinite(override[key]) ? override[key] : p.weight;
    if (Number.isFinite(w) && w > 0) weights[key] = w;
  }
  return weights;
}

// Pure weighted pick. `rand` ∈ [0,1) injected by the caller (Math.random in the script,
// fixed values in tests). Falls back to 'diff' when weights are empty/garbage.
export function pickProfileKey(weights, rand) {
  const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (!entries.length) return 'diff';
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let threshold = (Number.isFinite(rand) ? Math.max(0, Math.min(rand, 0.999999)) : 0) * total;
  for (const [key, w] of entries) {
    threshold -= w;
    if (threshold < 0) return key;
  }
  return entries[entries.length - 1][0];
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

// ── Diff manifest — constants ──

export const INLINE_DIFF_LIMIT_DEFAULT = 20000; // chars (~5k tokens); config key reviewGate.inlineDiffLimit
export const MANIFEST_TEXT_BUDGET = 12000;      // manifest total budget
export const MAX_HUNKS_PER_FILE = 10;           // each file hunk header number
export const MAX_MANIFEST_FILES = 300;          // exceeded churn use top N

export const LOW_VALUE_PATTERNS = [
  // lockfile
  { re: /(^|\/)package-lock\.json$/, reason: 'lockfile' },
  { re: /(^|\/)npm-shrinkwrap\.json$/, reason: 'lockfile' },
  { re: /(^|\/)yarn\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)pnpm-lock\.yaml$/, reason: 'lockfile' },
  { re: /(^|\/)bun\.lockb?$/, reason: 'lockfile' },
  { re: /(^|\/)Cargo\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)poetry\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)uv\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)Pipfile\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)composer\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)Gemfile\.lock$/, reason: 'lockfile' },
  { re: /(^|\/)go\.sum$/, reason: 'lockfile' },
  { re: /(^|\/)gradle\.lockfile$/, reason: 'lockfile' },
  { re: /(^|\/)flake\.lock$/, reason: 'lockfile' },
  // minified / sourcemap
  { re: /\.min\.(js|css|mjs)$/, reason: 'minified' },
  { re: /\.map$/, reason: 'sourcemap' },
  // generated / vendored
  { re: /(^|\/)dist\//, reason: 'generated (dist)' },
  { re: /(^|\/)build\//, reason: 'generated (build)' },
  { re: /(^|\/)out\//, reason: 'generated (out)' },
  { re: /(^|\/)vendor\//, reason: 'vendored' },
  { re: /(^|\/)node_modules\//, reason: 'vendored' },
  { re: /(^|\/)__snapshots__\//, reason: 'generated (snapshots)' },
  { re: /\.snap$/, reason: 'generated (snapshot)' },
  { re: /\.pb\.go$/, reason: 'generated (protobuf)' },
  { re: /\.generated\./, reason: 'generated' },
];

// ── Diff manifest — pure functions ──

export function classifyLowValue(filePath) {
  for (const { re, reason } of LOW_VALUE_PATTERNS) {
    if (re.test(filePath)) return reason;
  }
  return null;
}

// Parse `git diff --numstat -z -M` output.
// Records are NUL-terminated: `added\tdeleted\tpath\0` or `added\tdeleted\told\0new\0` for renames.
export function parseNumstatZ(buf) {
  const str = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = str.split('\0').filter(p => p.length > 0);
  const result = [];
  let i = 0;
  while (i < parts.length) {
    const header = parts[i];
    const t1 = header.indexOf('\t');
    const t2 = header.indexOf('\t', t1 + 1);
    if (t1 < 0 || t2 < 0) { i++; continue; }
    const added = header.slice(0, t1);
    const deleted = header.slice(t1 + 1, t2);
    const path = header.slice(t2 + 1);
    let renamedFrom = null;
    let finalPath = path;
    if (path === '') {
      // Real git -z rename/copy: header path empty; next two parts are old, new.
      renamedFrom = parts[i + 1] ?? null;
      finalPath = parts[i + 2] ?? '';
      i += 3;
    } else if (i + 1 < parts.length && !parts[i + 1].includes('\t')) {
      // Fallback: header carries the old path, next part is the new path.
      renamedFrom = path;
      finalPath = parts[i + 1];
      i += 2;
    } else {
      i++;
    }
    result.push({
      path: finalPath,
      added: added === '-' ? null : parseInt(added, 10),
      deleted: deleted === '-' ? null : parseInt(deleted, 10),
      binary: added === '-' && deleted === '-',
      renamedFrom,
    });
  }
  return result;
}

// Parse `git diff --name-status -z -M` output.
// Records: `status\0path\0` or `status\0old\0new\0` for renames/copies.
export function parseNameStatusZ(buf) {
  const str = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = str.split('\0').filter(p => p.length > 0);
  const result = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status.includes('\t')) { i++; continue; }
    const isStatus = /^[AMD]$/.test(status) || /^[RC]\d{2,3}$/.test(status);
    if (!isStatus) { i++; continue; }
    let renamedFrom = null;
    let path;
    if (i + 1 >= parts.length) break;
    // Rename/copy: next part is old path, part after that is new path
    if ((status.startsWith('R') || status.startsWith('C')) && i + 2 < parts.length && !parts[i + 2].includes('\t')) {
      renamedFrom = parts[i + 1];
      path = parts[i + 2];
      i += 3;
    } else {
      path = parts[i + 1];
      i += 2;
    }
    result.push({ status, path, renamedFrom });
  }
  return result;
}

// Build manifest from numstat + name-status + hunk headers. Returns { entries, excluded }.
export function buildManifest(numstatEntries, statusEntries, hunksByPath) {
  const statusByPath = new Map();
  for (const s of statusEntries) statusByPath.set(s.path, s);

  const numstatByPath = new Map();
  for (const n of numstatEntries) numstatByPath.set(n.path, n);

  const allPaths = new Set([...numstatByPath.keys(), ...statusByPath.keys()]);

  const entries = [];
  const excluded = [];

  for (const path of allPaths) {
    // Exclude binary files (numstat authoritative)
    const ns = numstatByPath.get(path);
    if (ns?.binary) {
      excluded.push({ path, reason: 'binary' });
      continue;
    }

    // Exclude pure renames (R100 + 0/0)
    const st = statusByPath.get(path);
    const isR100 = st?.status === 'R100';
    const isZeroChurn = ns && ns.added === 0 && ns.deleted === 0;
    if (isR100 && isZeroChurn) {
      excluded.push({ path, reason: 'pure rename (R100)' });
      continue;
    }

    // Exclude low-value files
    const lowReason = classifyLowValue(path);
    if (lowReason) {
      excluded.push({ path, reason: lowReason });
      continue;
    }

    entries.push({
      path,
      status: st?.status || 'M',
      renamedFrom: ns?.renamedFrom || st?.renamedFrom || null,
      added: ns?.added ?? 0,
      deleted: ns?.deleted ?? 0,
      binary: false,
      hunks: hunksByPath?.get(path) || [],
    });
  }

  return { entries, excluded };
}

// Decide review mode based on filtered diff size.
export function decideMode(filteredDiffChars, limit) {
  if (filteredDiffChars <= 0) return 'empty';
  if (filteredDiffChars <= limit) return 'review';
  return 'agent';
}

// Decide the overall manifest mode from the entry count and filtered diff size.
// No reviewable entries → 'empty' (the ONLY empty path). Entries present but no diff
// text (e.g. the full `git diff` exceeded maxBuffer and was caught to '') → 'agent',
// so an oversized diff is reviewed via the manifest rather than silently skipped.
// Otherwise fall back to the size-based decision.
export function decideManifestMode(entryCount, filteredDiffChars, limit) {
  if (entryCount === 0) return 'empty';
  if (filteredDiffChars <= 0) return 'agent';
  return decideMode(filteredDiffChars, limit);
}

// Render manifest as markdown table + hunk headers, capped at MANIFEST_TEXT_BUDGET.
export function renderManifestText(entries, { range, subPath } = {}) {
  if (!entries.length) return '';

  // Sort by churn descending, then limit
  const sorted = [...entries].sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  const overflow = sorted.length > MAX_MANIFEST_FILES ? sorted.length - MAX_MANIFEST_FILES : 0;
  const trimmed = sorted.slice(0, MAX_MANIFEST_FILES);

  const lines = [];
  lines.push(`## Changed files (${entries.length}${overflow ? `, +${overflow} more` : ''})`);
  if (range) lines.push(`Range: \`${range}\``);
  if (subPath) lines.push(`Scope: \`${subPath}\``);
  lines.push('');
  lines.push('| # | Status | +/- | Churn | File |');
  lines.push('|---|--------|-----|-------|------|');

  let idx = 0;
  for (const e of trimmed) {
    idx++;
    const churn = e.added + e.deleted;
    const churnLabel = churn > 2000 ? `${churn} (large)` : String(churn);
    const statusLabel = e.renamedFrom ? `${e.status} (from ${e.renamedFrom})` : e.status;
    lines.push(`| ${idx} | ${statusLabel} | +${e.added}/-${e.deleted} | ${churnLabel} | \`${truncateLine(e.path, 80)}\` |`);
  }

  // Hunk headers per file
  lines.push('');
  for (const e of trimmed) {
    if (!e.hunks?.length) continue;
    const hunkLines = e.hunks.slice(0, MAX_HUNKS_PER_FILE).map(h => `  ${truncateLine(h, 120)}`);
    const more = e.hunks.length > MAX_HUNKS_PER_FILE ? `  ... +${e.hunks.length - MAX_HUNKS_PER_FILE} more hunks` : '';
    if (hunkLines.length) {
      lines.push(`**\`${truncateLine(e.path, 80)}\`**`);
      lines.push(...hunkLines);
      if (more) lines.push(more);
      lines.push('');
    }
  }

  if (overflow) {
    lines.push(`*+${overflow} more files not shown (cap ${MAX_MANIFEST_FILES})*`);
  }

  // Truncate to budget on a line boundary so we never cut a table row (or a
  // multibyte char) mid-way and emit malformed markdown.
  const text = lines.join('\n');
  if (text.length <= MANIFEST_TEXT_BUDGET) return text;
  const sliced = text.slice(0, MANIFEST_TEXT_BUDGET - 4);
  const lastNl = sliced.lastIndexOf('\n');
  return (lastNl > 0 ? sliced.slice(0, lastNl) : sliced) + '\n...';
}

// Drop excluded files' segments from a full git diff. `excludedPaths` is keyed by the
// NEW (b/) path — matching how buildManifest keys entries — so renamed-and-excluded files
// (e.g. a moved lockfile/binary) are stripped too.
export function filterDiff(fullDiff, excludedPaths) {
  if (!excludedPaths || !excludedPaths.size) return fullDiff;
  const parts = fullDiff.split(/(?=^diff --git )/m);
  return parts.filter(part => {
    const m = part.match(/^diff --git a\/.+ b\/(.+)$/m);
    return !m || !excludedPaths.has(m[1]);
  }).join('');
}

// Extract `@@ ... @@` hunk headers from full git diff, grouped by file path.
export function extractHunkHeaders(diffText) {
  const map = new Map();
  let currentFile = null;

  const lines = diffText.split('\n');
  for (const line of lines) {
    // Detect file boundary: `diff --git a/<path> b/<path>`
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2]; // use b/ (new) path — matches buildManifest keying
      if (!map.has(currentFile)) map.set(currentFile, []);
      continue;
    }
    // Hunk header: `@@ -l,s +l,s @@` optionally followed by context
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
    if (hunkMatch && currentFile) {
      const fn = hunkMatch[5] ? hunkMatch[5].trim() : '';
      const header = `@@ -${hunkMatch[1]},${hunkMatch[2] || 1} +${hunkMatch[3]},${hunkMatch[4] || 1} @@${fn ? ' ' + fn : ''}`;
      map.get(currentFile).push(header);
    }
  }

  return map;
}

function truncateLine(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
