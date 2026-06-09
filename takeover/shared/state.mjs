// shared/state.mjs — unified .rem-state.json read/write
// Pure functions: stateFile path passed as parameter.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export const DEFAULT_STATE = {
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

export function saveState(stateFile, state) {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function appendEvent(stateFile, type, detail) {
  const state = loadState(stateFile);
  state.prune.events.push({ ts: new Date().toISOString(), type, ...detail });
  if (state.prune.events.length > 50) {
    state.prune.events = state.prune.events.slice(-50);
  }
  saveState(stateFile, state);
}
