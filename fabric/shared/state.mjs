// shared/state.mjs — unified .rem-state.json read/write
// Pure functions: stateFile path passed as parameter.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';

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
  prune: {
    lastPruneAt: 0,
    events: [],
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

// saveState(stateFile, state, { atomic })
// Default: direct write (back-compat). With { atomic: true }: write to a temp file then
// rename over the target so a crash never leaves a half-written state file. The rename can
// intermittently fail on Windows under OneDrive/AV — retry once, then give up without
// throwing. Returns { persisted } so callers (e.g. evolve's loop) can fall back to in-memory
// state instead of blocking. Pre-atomic callers ignore the return value, so this is safe.
export function saveState(stateFile, state, { atomic = false } = {}) {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(state, null, 2);

  if (!atomic) {
    writeFileSync(stateFile, payload, 'utf8');
    return { persisted: true };
  }

  const tmp = stateFile + '.tmp';
  const tryWrite = () => { writeFileSync(tmp, payload, 'utf8'); renameSync(tmp, stateFile); };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { tryWrite(); return { persisted: true }; }
    catch { /* retry once (Windows/OneDrive rename flake) */ }
  }
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  return { persisted: false };
}

export function appendEvent(stateFile, type, detail) {
  const state = loadState(stateFile);
  state.prune.events.push({ ts: new Date().toISOString(), type, ...detail });
  if (state.prune.events.length > 15) {
    state.prune.events = state.prune.events.slice(-15);
  }
  saveState(stateFile, state);
}
