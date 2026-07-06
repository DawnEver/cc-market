#!/usr/bin/env node
// doc-freshness.js — commit-anchored staleness for knowledge-base docs.
//
// A "bound doc" is ANY markdown file whose frontmatter declares `doc_source` (the
// source-code subtrees it documents). Drift is measured from a device-local ANCHOR
// (`git_hash`/`reviewed_at` in `.claude/.rem-state.json` docs.anchors, keyed by
// repo-relative path) — NOT the frontmatter. Stale = commits touching those subtrees
// since the anchor OR churn (insertions+deletions) OR days since reviewed_at, past
// threshold. A dangling doc_source (path no longer exists) is surfaced as stale too,
// so a broken binding never reads silently fresh.
//
// No config, no location entry point: a doc's *kind* is decided by its frontmatter,
// not its path, so bound docs are DISCOVERED repo-wide by that signature — wherever
// they live (`.claude/docs/`, the project's own `docs/`, anywhere). Enablement is
// implied by data (no bound docs ⇒ empty scan, zero cost). Thresholds default but
// may be overridden per-doc in the frontmatter. Frontmatter is tracked and carries
// only the semantic binding; the volatile anchor is device-local (gitignored).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from '../shared/spawn.mjs';
import { parseFrontmatter } from '../shared/lib.mjs';
import { loadState as _loadState, saveState as _saveState } from '../shared/state.mjs';
import { repoRoot, DAY_MS } from './lib.mjs';

// Doc-root cache is keyed to each repo's own state file, so it is correct in
// production (root = project) and isolated per temp repo in tests.
const stateFileFor = (root) => join(root, '.claude', '.rem-state.json');

export const DEFAULT_THRESHOLDS = { stale_commits: 15, stale_days: 30, stale_lines: 200 };

// The dated memory tree is the opposite lifecycle and never carries doc_source,
// so it is excluded from doc discovery even though it isn't gitignored.
const MEMORY_PREFIX = '.claude/memory/';

// Resolve thresholds: per-doc frontmatter override wins per-field, else defaults.
export function resolveThresholds(override = {}) {
  const o = override || {};
  return {
    stale_commits: o.stale_commits ?? DEFAULT_THRESHOLDS.stale_commits,
    stale_days: o.stale_days ?? DEFAULT_THRESHOLDS.stale_days,
    stale_lines: o.stale_lines ?? DEFAULT_THRESHOLDS.stale_lines,
  };
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Extract the doc-binding fields from a file's frontmatter. The binding keys live
// under `metadata:` but we tolerate them at the top level too. Returns null unless
// a non-empty `doc_source` is present (i.e. the file is a bound doc).
export function parseDocMeta(content) {
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const md = (fm.metadata && typeof fm.metadata === 'object') ? fm.metadata : {};
  const doc_source = md.doc_source ?? fm.doc_source;
  if (!Array.isArray(doc_source) || doc_source.length === 0) return null;
  // Frontmatter carries only the SEMANTIC binding (tracked): what code the doc
  // covers + optional thresholds. The volatile anchor (git_hash/reviewed_at) is
  // NOT here — it lives device-locally in .rem-state.json (see loadAnchor).
  return {
    doc_source,
    stale_commits: toInt(md.stale_commits ?? fm.stale_commits),
    stale_days: toInt(md.stale_days ?? fm.stale_days),
    stale_lines: toInt(md.stale_lines ?? fm.stale_lines),
  };
}

// Whole-day delta between an ISO date and today. Missing date → Infinity (a doc
// that never recorded a review point is treated as maximally stale).
export function dayDrift(reviewedAt, today) {
  if (!reviewedAt) return Infinity;
  const then = new Date(reviewedAt).getTime();
  const now = new Date(today).getTime();
  if (Number.isNaN(then) || Number.isNaN(now)) return Infinity;
  return Math.floor((now - then) / DAY_MS);
}

export function isDocStale({ commits, days, lines }, thresholds) {
  return commits >= thresholds.stale_commits
    || days >= thresholds.stale_days
    || lines >= thresholds.stale_lines;
}

// Commits touching any of `paths` between `gitHash` and HEAD. Missing hash →
// Infinity (unanchored). git failure (bad hash, not a repo) → Infinity so the
// doc surfaces for review rather than being silently skipped.
export function commitDrift(cwd, gitHash, paths) {
  if (!gitHash) return { commits: Infinity };
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${gitHash}..HEAD`, '--', ...paths], {
      cwd, timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    return { commits: parseInt(out.trim(), 10) || 0 };
  } catch {
    return { commits: Infinity, error: 'git-failed' };
  }
}

// Churn (insertions + deletions) in `paths` between `gitHash` and HEAD — a better
// proxy than commit count for "did the documented behavior actually change".
export function lineDrift(cwd, gitHash, paths) {
  if (!gitHash) return Infinity;
  try {
    const out = execFileSync('git', ['diff', '--shortstat', `${gitHash}..HEAD`, '--', ...paths], {
      cwd, timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    const ins = /(\d+) insertion/.exec(out);
    const del = /(\d+) deletion/.exec(out);
    return (ins ? +ins[1] : 0) + (del ? +del[1] : 0);
  } catch {
    return Infinity;
  }
}

// Device-local freshness anchor for a doc (git_hash + reviewed_at), keyed by
// repo-relative path in .rem-state.json — never in the tracked frontmatter.
export function loadAnchor(root, relPath) {
  return _loadState(stateFileFor(root)).docs?.anchors?.[relPath] || {};
}

export function saveAnchor(root, relPath, anchor) {
  const state = _loadState(stateFileFor(root));
  state.docs = { ...(state.docs || {}) };
  state.docs.anchors = { ...(state.docs.anchors || {}), [relPath]: anchor };
  _saveState(stateFileFor(root), state);
}

// List repo-relative .md paths honoring .gitignore — git already knows what to
// skip (vendored, build, ignored dirs), so we reuse it instead of a hardcoded
// skip list. `restrict` (cached doc roots) narrows the walk when known.
export function listMarkdownFiles(root, restrict = null) {
  if (Array.isArray(restrict) && restrict.length === 0) return []; // known-none
  const patterns = Array.isArray(restrict) ? restrict.map(r => `${r}/*.md`) : ['*.md'];
  const args = ['-C', root, 'ls-files', '-co', '--exclude-standard', '--', ...patterns];
  let out;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  } catch {
    return []; // not a git repo — doc freshness is git-anchored anyway
  }
  return out.split('\n').map(s => s.trim()).filter(Boolean).filter(rel => !rel.startsWith(MEMORY_PREFIX));
}

// Discover bound docs by frontmatter signature — location is not configured, kind
// is decided by the frontmatter. relPath is repo-relative (the doc's identity).
export function collectBoundDocs(root, restrict = null) {
  const docs = [];
  for (const rel of listMarkdownFiles(root, restrict)) {
    const full = join(root, rel);
    try {
      const meta = parseDocMeta(readFileSync(full, 'utf8'));
      if (meta) docs.push({ relPath: rel, full, ...meta });
    } catch { /* skip unreadable */ }
  }
  return docs;
}

// A doc's "root": its `.claude/<sub>` two-segment prefix, else its top segment.
export function docRootOf(relPath) {
  const segs = relPath.split('/');
  return segs[0] === '.claude' && segs.length > 2 ? `${segs[0]}/${segs[1]}` : segs[0];
}

// Resolve the doc roots to scan. Uses the device-local cache when present; else
// discovers repo-wide and, if unambiguous (≤1 root), persists it. Returns
// { roots, ambiguous } — ambiguous:true (multiple distinct roots, no cached
// choice) signals the skill to ask the user which to track.
export function resolveDocRoots(root = repoRoot) {
  const cached = _loadState(stateFileFor(root)).docs?.roots;
  if (Array.isArray(cached)) return { roots: cached };
  const roots = [...new Set(collectBoundDocs(root).map(d => docRootOf(d.relPath)))].sort();
  if (roots.length <= 1) { saveDocRoots(root, roots); return { roots }; }
  return { roots, ambiguous: true };
}

export function saveDocRoots(root, roots) {
  const state = _loadState(stateFileFor(root));
  state.docs = { ...(state.docs || {}), roots };
  _saveState(stateFileFor(root), state);
}

// Evaluate stale bound docs. Scans only the resolved (cached/discovered) roots.
// Each doc's own frontmatter thresholds win over the built-in defaults.
export function evaluateDocs(root, cwd, today) {
  const { roots } = resolveDocRoots(root);
  const stale = [];
  for (const doc of collectBoundDocs(root, roots)) {
    const th = resolveThresholds(doc);
    const { git_hash, reviewed_at } = loadAnchor(root, doc.relPath);
    // A doc_source that no longer exists (typo, rename, deletion) yields 0 drift
    // forever — it would read silently fresh. Surface it as stale/dangling instead.
    const dangling = doc.doc_source.filter(p => !existsSync(join(root, p)));
    const { commits } = commitDrift(cwd, git_hash, doc.doc_source);
    const days = dayDrift(reviewed_at, today);
    const lines = lineDrift(cwd, git_hash, doc.doc_source);
    if (dangling.length || isDocStale({ commits, days, lines }, th)) {
      stale.push({ ...doc, git_hash, reviewed_at, commits, days, lines, dangling });
    }
  }
  return stale;
}

// ── CLI ──
function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');

  // Bust the discovery cache: --rediscover (docs.roots → null → re-derived next scan).
  // Needed after adding a bound doc under a NEW root, since a cached single root
  // narrows the walk and would not see it.
  if (argv.includes('--rediscover')) {
    saveDocRoots(repoRoot, null);
    console.log('[doc-freshness] discovery cache cleared — roots re-derived on next scan');
    return;
  }

  // Persist the user-chosen doc roots after disambiguation: --set-roots a,b
  const setIdx = argv.indexOf('--set-roots');
  if (setIdx >= 0) {
    const roots = (argv[setIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
    saveDocRoots(repoRoot, roots);
    console.log(`[doc-freshness] doc roots set: ${roots.length ? roots.join(', ') : '(none)'}`);
    return;
  }

  // Re-anchor a doc after refresh: --set-anchor <relPath> [hash]. Records the
  // device-local anchor (defaults to HEAD / today) so the doc reads fresh again.
  const anchorIdx = argv.indexOf('--set-anchor');
  if (anchorIdx >= 0) {
    const relPath = argv[anchorIdx + 1];
    if (!relPath) { console.error('[doc-freshness] --set-anchor requires <relPath>'); process.exit(1); }
    let git_hash = argv[anchorIdx + 2];
    if (!git_hash || git_hash.startsWith('--')) {
      git_hash = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    }
    const reviewed_at = new Date().toISOString().slice(0, 10);
    saveAnchor(repoRoot, relPath, { git_hash, reviewed_at });
    console.log(`[doc-freshness] anchored ${relPath} @ ${git_hash} (${reviewed_at})`);
    return;
  }

  // Surface ambiguity so the caller (skill) can ask the user which root to track.
  const resolved = resolveDocRoots(repoRoot);
  if (resolved.ambiguous) {
    const payload = { ambiguous: true, candidates: resolved.roots };
    console.log(jsonMode ? JSON.stringify(payload)
      : `─── Doc freshness ───\n  Multiple doc roots found: ${resolved.roots.join(', ')}\n  Pick one/some: doc-freshness.js --set-roots <a,b>`);
    process.exit(2);
  }

  const today = new Date().toISOString().slice(0, 10);
  const stale = evaluateDocs(repoRoot, repoRoot, today);

  if (jsonMode) {
    console.log(JSON.stringify({ stale: stale.map(d => ({
      path: d.relPath.replace(/\\/g, '/'), doc_source: d.doc_source,
      git_hash: d.git_hash || null, commits: d.commits, days: d.days, lines: d.lines,
      dangling: d.dangling && d.dangling.length ? d.dangling : undefined,
    })) }));
  } else if (stale.length === 0) {
    console.log('─── Doc freshness ───\n  No stale bound docs.');
  } else {
    console.log('─── Doc freshness ───');
    for (const d of stale) {
      const range = d.git_hash ? `${d.git_hash}..HEAD` : 'unanchored';
      const n = v => v === Infinity ? '∞' : v;
      const dang = d.dangling && d.dangling.length ? ` ⛔ dangling doc_source: ${d.dangling.join(', ')}` : '';
      console.log(`  ⚠ ${d.relPath.replace(/\\/g, '/')} — ${n(d.commits)} commits / ${n(d.lines)} lines / ${n(d.days)}d (${range})${dang}`);
    }
  }
  process.exit(stale.length > 0 ? 1 : 0);
}

import { isMain } from '../shared/lib.mjs';
if (isMain(import.meta)) main();
