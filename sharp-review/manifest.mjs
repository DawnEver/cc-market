// manifest.mjs — Sharp Review diff-manifest logic: low-value/doc/lockfile classification,
// git -z parsing, manifest building, mode decision, and size-bounded rendering.
// Re-exported via lib.mjs.

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

// True when `filePath` is a dependency lockfile — reuses the lockfile entries in
// LOW_VALUE_PATTERNS (single source of truth). Drives the `deps` review source.
export function isLockfile(filePath) {
  for (const { re, reason } of LOW_VALUE_PATTERNS) {
    if (reason === 'lockfile' && re.test(filePath)) return true;
  }
  return false;
}

// True when `filePath` matches any generated/vendored/minified LOW_VALUE pattern (dist/,
// build/, out/, vendor/, node_modules/, *.generated.*, *.min.*, *.map, snapshots, protobuf).
// Reused by isDoc so the dist/build/out/vendor list lives in one place (LOW_VALUE_PATTERNS).
export function isGeneratedPath(filePath) {
  for (const { re, reason } of LOW_VALUE_PATTERNS) {
    if ((reason.startsWith('generated') || reason === 'vendored' || reason === 'minified' || reason === 'sourcemap')
        && re.test(filePath)) {
      return true;
    }
  }
  return false;
}

// Human-authored documentation by name (case-insensitive, with or without extension).
// NOTE: LICENSE is intentionally NOT a doc.
const DOC_NAME_RE = /(^|\/)(README|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|GLOBAL-AGENTS|CODE_OF_CONDUCT|SECURITY|NOTICE)([.][^/]*)?$/i;
// Markup documentation extensions.
const DOC_EXT_RE = /\.(md|mdx|rst|adoc|txt|org)$/i;
// Auto-generated / built documentation trees that must NOT fire the docs source. The exclusion
// wins over inclusion (a `.md` under docs/api/ is excluded). Covers sphinx/mkdocs/jekyll/
// docusaurus/javadoc/rustdoc/storybook outputs plus a generic generated guard.
const DOC_BUILD_RE = new RegExp([
  /(^|\/)(_site|site|storybook-static)\//.source,        // jekyll _site, mkdocs site, storybook
  /(^|\/)\.docusaurus\//.source,                         // docusaurus cache
  /(^|\/)docs\/(_build|api|html)\//.source,              // sphinx _build, generated api/html under docs
  /(^|\/)target\/doc\//.source,                          // rustdoc
  /(^|\/)(javadoc|apidocs)\//.source,                    // javadoc / generated apidocs
  /\.generated\./.source,                                // *.generated.md
  /(^|\/)_build\//.source,                               // generic build tree
  /(^|\/)\.cache\//.source,                              // generic cache
].join('|'), 'i');

// True when `filePath` is human-authored documentation. The exclusion check (generated/built
// docs, vendored trees) WINS over inclusion. Drives the `docs` review source.
export function isDoc(filePath) {
  if (isGeneratedPath(filePath) || DOC_BUILD_RE.test(filePath)) return false;
  if (/(^|\/)LICEN[CS]E([.][^/]*)?$/i.test(filePath)) return false; // LICENSE is explicitly NOT a doc
  if (DOC_NAME_RE.test(filePath)) return true;
  if (/(^|\/)docs?\//i.test(filePath)) return true;      // docs/ or doc/ at any depth
  return DOC_EXT_RE.test(filePath);
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
