#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = '.claude/.rem-state.json';
const TMP_FILE = '.claude/.rem-state.tmp';

const SEVERITY_ORDER = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const BLOCKING = new Set(['HIGH', 'MEDIUM']);

function sevRank(s) {
  return SEVERITY_ORDER[String(s || 'INFO').toUpperCase()] ?? 0;
}

export function initState({
  until = 'ask',
  maxRounds = 10,
  maxAgents = 8,
  minSeverity = 'LOW',
  path = null,
  dryRun = false,
  seed = false,
  commitMode = 'round',
} = {}) {
  return {
    round: 0,
    until,
    maxRounds,
    maxAgents,
    minSeverity,
    path,
    dryRun,
    seed,
    commitMode,
    lastRoundAt: null,
    emptyRounds: 0,
    findings: [],
  };
}

function statePath(projectRoot) {
  return path.join(projectRoot, STATE_FILE);
}

export function loadState(projectRoot = process.cwd()) {
  const defaults = initState();
  const file = statePath(projectRoot);
  try {
    if (!fs.existsSync(file)) return defaults;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaults, ...(raw.evolveState || {}) };
  } catch {
    return defaults;
  }
}

export function saveState(projectRoot = process.cwd(), state) {
  const file = statePath(projectRoot);
  const tmp = path.join(projectRoot, TMP_FILE);
  if (!fs.existsSync(file)) return { persisted: false };

  let root;
  try {
    root = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    root = {};
  }
  root.evolveState = state;
  const payload = JSON.stringify(root, null, 2);

  const tryRename = () => {
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  };

  try {
    tryRename();
    return { persisted: true };
  } catch {
    try {
      tryRename();
      return { persisted: true };
    } catch {
      try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
      return { persisted: false };
    }
  }
}

function findingFiles(f) {
  const set = new Set();
  if (f.file) set.add(f.file);
  for (const x of f.files || []) set.add(x);
  return set;
}

export function groupFindings(findings) {
  const sorted = [...findings].sort((a, b) => {
    const fa = String(a.file || '');
    const fb = String(b.file || '');
    if (fa !== fb) return fa < fb ? -1 : 1;
    return String(a.id || '') < String(b.id || '') ? -1 : 1;
  });

  const parent = sorted.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const fileSets = sorted.map(findingFiles);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      let shared = false;
      for (const f of fileSets[i]) if (fileSets[j].has(f)) { shared = true; break; }
      if (shared) union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(sorted[i]);
  }
  return [...byRoot.values()];
}

export function prioritize(findings, minSeverity = 'INFO') {
  const min = sevRank(minSeverity);
  return findings
    .filter((f) => sevRank(f.severity) >= min)
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
}

function normalizeSummary(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function confirmedByQuorum(rawFindings, minReviewers = 2) {
  const groups = new Map();
  for (const f of rawFindings) {
    const key = `${f.file || ''}::${normalizeSummary(f.summary)}`;
    if (!groups.has(key)) groups.set(key, { findings: [], reviewers: new Set() });
    const g = groups.get(key);
    g.findings.push(f);
    if (f.reviewer != null) g.reviewers.add(f.reviewer);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.reviewers.size >= minReviewers) out.push(g.findings[0]);
  }
  return out;
}

export function recordRound(state, { findings = [], fixed = [], wontFix = [] } = {}, now = 0) {
  state.round += 1;
  state.lastRoundAt = now;

  const fixedSet = new Set(fixed);
  const wontFixSet = new Set(wontFix);
  const incoming = new Map();

  for (const f of findings) {
    if (f.id != null) incoming.set(f.id, f);
    const existing = state.findings.find((e) => e.id === f.id);
    if (existing) {
      Object.assign(existing, f);
    } else {
      state.findings.push({ status: 'open', unfixedRounds: 0, ...f });
    }
  }

  let newBlockingOpen = 0;
  for (const f of state.findings) {
    if (fixedSet.has(f.id)) {
      f.status = 'fixed';
    } else if (wontFixSet.has(f.id)) {
      f.status = 'wont-fix';
    } else if (f.status === 'open') {
      f.unfixedRounds = (f.unfixedRounds || 0) + 1;
    }
  }

  for (const f of findings) {
    if (fixedSet.has(f.id) || wontFixSet.has(f.id)) continue;
    if (BLOCKING.has(String(f.severity || '').toUpperCase())) newBlockingOpen += 1;
  }

  if (newBlockingOpen > 0) state.emptyRounds = 0;
  else state.emptyRounds = (state.emptyRounds || 0) + 1;

  return state;
}

export function checkTermination(state) {
  if (state.round >= state.maxRounds) return { stop: true, reason: 'max-rounds' };
  if (state.findings.some((f) => (f.unfixedRounds || 0) >= 3)) {
    return { stop: true, reason: 'stuck-finding' };
  }

  switch (state.until) {
    case 'ask':
      return { stop: false, reason: 'ask' };
    case 'clean':
      if ((state.emptyRounds || 0) >= 2) return { stop: true, reason: 'clean-converged' };
      return { stop: false, reason: 'clean' };
    case 'resolved': {
      const allResolved = state.findings.every(
        (f) => f.status === 'fixed' || f.status === 'wont-fix'
      );
      const noNewOpen = (state.emptyRounds || 0) >= 1 || state.findings.length === 0;
      if (allResolved && noNewOpen) return { stop: true, reason: 'all-resolved' };
      return { stop: false, reason: 'resolved' };
    }
    default:
      return { stop: false, reason: 'unknown-mode' };
  }
}

// ---------------- CLI ----------------

function parseArgs(argv) {
  const positional = [];
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i].startsWith('--root=')) root = argv[i].slice('--root='.length);
    else positional.push(argv[i]);
  }
  return { positional, root };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, root } = parseArgs(rest);
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

  switch (cmd) {
    case 'init':
      out(initState());
      break;
    case 'load':
      out(loadState(root));
      break;
    case 'group': {
      const findings = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
      out(groupFindings(findings));
      break;
    }
    case 'terminate':
      out(checkTermination(loadState(root)));
      break;
    case 'prioritize': {
      const minSeverity = positional[0] || loadState(root).minSeverity;
      out(prioritize(loadState(root).findings, minSeverity));
      break;
    }
    default:
      process.stderr.write(
        'usage: evolve.mjs <init|load|group <file.json>|terminate|prioritize <minSeverity>> [--root <dir>]\n'
      );
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evolve.mjs')) {
  main();
}
