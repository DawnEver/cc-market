#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from '../shared/spawn.mjs';
import { atomicWriteFile } from '../shared/atomic-write.mjs';
import { parseFindingsFromMarkdown, dateToPath, isMain } from '../shared/lib.mjs';
import { route as routeAttention } from '../shared/attention.mjs';

const STATE_PATH = 'evolve/state.json';

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

// The loop state is per-worktree, device-local and never tracked, so git owns its place:
// `<git dir>/evolve/state.json` (`git rev-parse --git-path`). No plugin shares the file.
export function statePath(projectRoot = process.cwd()) {
  let rel;
  try {
    rel = execFileSync('git', ['rev-parse', '--git-path', STATE_PATH], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`evolve: ${projectRoot} is not a git checkout, so its loop state has no place.\n`
      + 'Door: run evolve inside the repository it improves (or `git init` it first).');
  }
  return path.resolve(projectRoot, rel);
}

export function loadState(projectRoot = process.cwd()) {
  const file = statePath(projectRoot);
  if (!fs.existsSync(file)) return initState();
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return { ...initState(), ...JSON.parse(raw) };
}

// Atomic tmp+rename; a failed rename (Windows AV) reports { persisted: false } and the round
// continues in memory.
export function saveState(projectRoot = process.cwd(), state) {
  const file = statePath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFile(file, JSON.stringify(state, null, 2));
    return { persisted: true };
  } catch {
    return { persisted: false };
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

// Step 7.5 — round-completion check. After commit, every finding from this round must be
// terminal (fixed / wont-fix). Any still-`open` finding means the round is NOT done; surface
// it rather than silently carrying it forward (unfixedRounds keeps climbing until the
// stuck-finding cap). Returns the un-terminal set for routing through the attention gate.
export function checkRoundComplete(state) {
  const openFindings = (state.findings || []).filter(
    (f) => String(f.status || 'open').toLowerCase() === 'open'
  );
  return { complete: openFindings.length === 0, openFindings };
}

// Map open findings to attention-gate items. An arch/interface change is irreversible and
// must reach a human; everything else carries a safe `defer` default (keep it OPEN, log it),
// so for an AI consumer or a low-stakes human round it auto-defers without an interruption.
export function findingsToAttentionItems(findings = []) {
  const sevStake = (s) => {
    const u = String(s || '').toUpperCase();
    return u === 'HIGH' ? 'HIGH' : u === 'MEDIUM' ? 'MEDIUM' : 'LOW';
  };
  return findings.map((f) => ({
    id: f.id,
    title: f.summary || f.id,
    detail: f.file ? `${f.file}: ${f.summary || ''}` : f.summary || '',
    kind: f.arch ? 'arch' : (f.reason || 'open-finding'),
    stakes: sevStake(f.severity),
    reversible: !f.arch,
    default: f.arch ? null : 'defer',
    options: [
      { label: 'Fix next round', value: 'fix', consequence: 'Re-enters fan-out next round.' },
      { label: "Won't fix", value: 'wont-fix', consequence: 'Recorded as accepted, with reason.' },
      { label: 'Defer', value: 'defer', consequence: 'Left OPEN; revisited next round.' },
    ],
  }));
}

// Route an incomplete round's open findings through the attention gate (shared/attention.mjs).
// consumer 'human' → coalesced AskUserQuestion payload (or silent defaults); 'ai' → policy + defer.
export function routeRoundCompletion(state, { consumer = 'human' } = {}) {
  const { openFindings } = checkRoundComplete(state);
  return routeAttention(findingsToAttentionItems(openFindings), { consumer });
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

// Cleanup: write the round-log as a memory entry with frontmatter into
// .claude/memory/YYYY/MM/DD/. Returns the written path.
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

if (isMain(import.meta.url)) {
  main();
}
