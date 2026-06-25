#!/usr/bin/env node
// Scope-split orchestrator for the REM memory system.
//
//   node scope-split.js --check                          → exit 0 if a split candidate exists, exit 1 otherwise
//   node scope-split.js --propose                         → JSON: candidate child scopes + their entries
//   node scope-split.js --execute --scope <subdir> \
//        --entries <rel1,rel2,...>                         → relocate entries into the child scope (move + tombstone)
//
// Generic and structure-agnostic: a candidate child scope must correspond to a real
// subdirectory that the clustered entries reference. In a flat repo with no internal
// module boundary, --check exits 1 and nothing is proposed. User-gated like crystallize:
// the model presents --propose output, the user confirms each split, then --execute runs.
//
// Workflow:
//   1. Model runs --check; if exit 0 → a split candidate exists
//   2. Model runs --propose → presents candidate scope(s) + entry lists to user
//   3. User confirms a specific split (per-candidate)
//   4. Model runs --execute --scope <subdir> --entries <paths>

import {
  scopeRoot, proposeScopeSplits, executeScopeSplit, resolveSplitConfig,
} from './lib.mjs';

const args = process.argv.slice(2);
const mode = args[0] || '--check';

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

// ── --check: does any split candidate exist? ──
if (mode === '--check') {
  const candidates = proposeScopeSplits(scopeRoot);
  if (candidates.length > 0) {
    const cfg = resolveSplitConfig();
    console.log(`[scope-split] ${candidates.length} candidate scope(s) — split available ` +
      `(thresholds: ≥${cfg.minOwnEntries} own entries or >${Math.round(cfg.maxBytes / 1024)}KB, ` +
      `≥${cfg.minClusterEntries} per cluster)`);
    for (const c of candidates) console.log(`  → ${c.scope} (${c.entryCount} entries)`);
    process.exit(0);
  }
  console.log('[scope-split] no split candidate — nothing to do');
  process.exit(1);
}

// ── --propose: JSON listing of candidate child scopes ──
if (mode === '--propose') {
  const candidates = proposeScopeSplits(scopeRoot);
  console.log(JSON.stringify({ scopeRoot, candidates }, null, 2));
  process.exit(0);
}

// ── --execute: relocate entries into a child scope ──
if (mode === '--execute') {
  const subdir = flag('--scope');
  const entriesArg = flag('--entries');
  if (!subdir || !entriesArg) {
    console.error('[scope-split] --execute requires --scope <subdir> --entries <rel1,rel2,...>');
    process.exit(1);
  }
  const entries = entriesArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) {
    console.error('[scope-split] no entries given');
    process.exit(1);
  }
  const res = executeScopeSplit(scopeRoot, subdir, entries);
  console.log(`[scope-split] moved ${res.moved} entr${res.moved === 1 ? 'y' : 'ies'} → ${res.scope}/.claude/memory/`);
  console.log(`[scope-split] parent index tombstoned (migrated→${res.scope}); both indexes rebuilt`);
  console.log('[scope-split] reminder: update the parent AGENTS.md / README "Scoped" prose if this split is architecturally meaningful');
  process.exit(0);
}

// ── default ──
console.log('Usage: node scope-split.js [--check|--propose|--execute --scope <subdir> --entries <paths>]');
process.exit(1);
