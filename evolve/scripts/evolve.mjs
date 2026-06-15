#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadState as loadSharedState, saveState as saveSharedState } from '../shared/state.mjs';
import { parseFindingsFromMarkdown, dateToPath } from '../shared/lib.mjs';

const STATE_FILE = '.claude/.rem-state.json';

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

// State lives under the `evolveState` key of the shared `.claude/.rem-state.json` (owned by
// the required rem plugin). loadState/saveState delegate to shared/state.mjs — its deepMerge
// preserves foreign keys (hook, prune, reviewGate…) so we never clobber rem/sharp-review's
// slice of the file, and its atomic save (with Windows-retry) replaces evolve's old
// hand-rolled temp/rename dance.
export function loadState(projectRoot = process.cwd()) {
  const root = loadSharedState(statePath(projectRoot));
  return { ...initState(), ...(root.evolveState || {}) };
}

export function saveState(projectRoot = process.cwd(), state) {
  const file = statePath(projectRoot);
  const root = loadSharedState(file); // returns DEFAULT_STATE if absent; shared save creates the dir
  root.evolveState = state;
  return saveSharedState(file, root, { atomic: true });
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

function memoryDayDir(projectRoot, date) {
  return path.join(projectRoot, '.claude', 'memory', ...dateToPath(date).split('/'));
}

// --seed: pull OPEN findings from an existing sharp-review backlog instead of re-critiquing.
// Reuses shared/lib.mjs parseFindingsFromMarkdown + SR-ID parsing rather than a new parser.
export function seedFromSharpReview(projectRoot = process.cwd(), date) {
  const file = path.join(memoryDayDir(projectRoot, date), 'sharp-review.md');
  if (!fs.existsSync(file)) return [];
  return parseFindingsFromMarkdown(fs.readFileSync(file, 'utf8'), date)
    .filter((f) => String(f.status || 'open').toLowerCase() === 'open')
    .map((f) => ({
      id: f.id, file: f.file, summary: f.summary, severity: f.severity,
      status: 'open', unfixedRounds: 0,
    }));
}

// Cleanup: write the round-log as a memory entry with rem frontmatter into
// .claude/memory/YYYY/MM/DD/ so rem's existing SessionStart indexer picks it up — no need to
// call rem's rebuildIndex directly. Returns the written path.
export function writeRoundLog(projectRoot = process.cwd(), { date, rounds, fixed = 0, wontFix = 0, deferred = 0, note = '' } = {}) {
  const dir = memoryDayDir(projectRoot, date);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'evolve-round-log.md');
  const body = `---
name: evolve-round-log-${dateToPath(date).replace(/\//g, '-')}
description: evolve loop — ${rounds} round(s), ${fixed} fixed, ${wontFix} won't-fix${deferred ? `, ${deferred} deferred` : ''}
metadata:
  type: project
---

evolve ran ${rounds} round(s): ${fixed} fixed, ${wontFix} won't-fix${deferred ? `, ${deferred} deferred` : ''}.${note ? ` ${note}` : ''}
`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
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
    case 'seed':
      out(seedFromSharpReview(root, positional[0]));
      break;
    default:
      process.stderr.write(
        'usage: evolve.mjs <init|load|group <file.json>|terminate|prioritize <minSeverity>|seed [date]> [--root <dir>]\n'
      );
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evolve.mjs')) {
  main();
}
