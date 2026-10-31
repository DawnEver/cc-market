// shared/state.mjs — unified .rem-state.json read/write
// Pure functions: stateFile path passed as parameter.

import { readFileSync, existsSync } from 'fs';
import { atomicWriteFile } from './atomic-write.mjs';
import { withLock } from './lock.mjs';

export const DEFAULT_STATE = {
  // Schema version of the whole state file. Bump when a key's shape changes
  // incompatibly; plugin migrations key off it. Key ownership table:
  // cc-market/.claude/rules/invariants.md § "State file ownership".
  version: 1,
  hook: {
    sessionKey: null,
    stopCount: 0,
    firstStopAt: null,
    remPending: false,
    remDone: false,
    lastTouched: null,
    taskActiveUntil: null,
  },
  scopes: {
    // Glob/name patterns for directories findAllScopes/findChildScopes skip during
    // scope discovery. Bare names (no `/`) match a directory's basename; patterns
    // with `/` match the path relative to the scan root. Supports `*` and `?`.
    ignore: [],
  },
  docs: {
    // Device-local CACHE of where bound docs (frontmatter `doc_source`) were
    // discovered — NOT config. Source of truth stays the frontmatter signatures;
    // this only memoizes the discovered doc root(s) to avoid re-walking the repo.
    // null = never discovered; [] = discovered, none found; [..] = doc roots.
    roots: null,
    // Device-local freshness ANCHORS, keyed by repo-relative doc path:
    // { "<relPath>": { git_hash, reviewed_at } }. Kept out of git (and out of the
    // doc frontmatter) so the tracked doc stays pure semantic binding; the mutable
    // "last validated at commit X" bookkeeping is per-device (OneDrive-synced).
    anchors: {},
  },
};

function deepMerge(defaults, partial) {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return partial !== undefined ? partial : defaults;
  }
  if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
    return JSON.parse(JSON.stringify(defaults));
  }
  const result = {};
  for (const key of Object.keys(defaults)) {
    result[key] = deepMerge(defaults[key], partial[key]);
  }
  // Preserve extra keys from partial that are not in defaults
  // (e.g. reviewGate added by other plugins sharing the same state file)
  for (const key of Object.keys(partial)) {
    if (!(key in defaults)) {
      result[key] = JSON.parse(JSON.stringify(partial[key]));
    }
  }
  return result;
}

export function loadState(stateFile) {
  try {
    if (!existsSync(stateFile)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    let raw = readFileSync(stateFile, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const partial = JSON.parse(raw);
    return deepMerge(DEFAULT_STATE, partial);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

// saveState(stateFile, state, { onTimeout })
// Always tmp+rename (shared/atomic-write.mjs): a reader never sees a torn file, so
// loadState never falls back to defaults over a half-written one and clobbers it.
// Returns { persisted } — a failed rename (Windows AV/OneDrive) reports false
// instead of throwing, so hooks degrade to in-memory state. The write is
// lease-locked; hooks default to onTimeout 'proceed', mutating CLIs pass 'throw'.
export function saveState(stateFile, state, { onTimeout = 'proceed' } = {}) {
  return withLock(stateFile, () => {
    try { atomicWriteFile(stateFile, JSON.stringify(state, null, 2)); return { persisted: true }; }
    catch { return { persisted: false }; }
  }, { onTimeout });
}

// withStateLock(stateFile, fn, { onTimeout })
// Atomic load→mutate→save: loads FRESH state inside the lock, lets fn(state)
// mutate it, then saves — closing the TOCTOU window where a caller classifies
// from a stale snapshot and overwrites another process's concurrent write.
// Returns { persisted } from the inner saveState.
export function withStateLock(stateFile, fn, { onTimeout = 'proceed' } = {}) {
  return withLock(stateFile, () => {
    const state = loadState(stateFile);
    fn(state);
    return saveState(stateFile, state, { onTimeout }); // reentrant
  }, { onTimeout });
}

