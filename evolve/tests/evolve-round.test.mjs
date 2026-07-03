// Integration test — one simulated evolve round end-to-end at the script API/CLI level:
// seed OPEN findings from a real sharp-review.md, prioritize, record the round, persist
// state under `evolveState` (without clobbering foreign keys), simulate fixes in the memory
// file, run an empty round, and verify termination.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  initState,
  loadState,
  saveState,
  recordRound,
  prioritize,
  checkTermination,
  checkRoundComplete,
  seedFromSharpReview,
} from '../scripts/evolve.mjs';

const EVOLVE_MJS = fileURLToPath(new URL('../scripts/evolve.mjs', import.meta.url));
const DATE = '2026-07-03';

const SR_BACKLOG = `---
name: sharp-review-2026-07-03
---

# Sharp Review — 2026-07-03

### [SR-20260703-001] [HIGH] src/server.js — Unvalidated user input reaches SQL query
- **Status:** open
- **Module:** server

### [SR-20260703-002] [MEDIUM] src/utils.js — parseConfig swallows JSON errors silently
- **Status:** open
- **Module:** utils

### [SR-20260703-003] [LOW] src/utils.js — Inconsistent log prefix casing
- **Status:** open

### [SR-20260703-004] [MEDIUM] src/cache.js — Stale TTL never evicted
- **Status:** fixed
`;

let root;
let srFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-round-test-'));
  const day = path.join(root, '.claude', 'memory', '2026', '07', '03');
  fs.mkdirSync(day, { recursive: true });
  srFile = path.join(day, 'sharp-review.md');
  fs.writeFileSync(srFile, SR_BACKLOG, 'utf8');
  // Pre-seed the shared state file with foreign plugin keys (rem + sharp-review slices).
  fs.writeFileSync(
    path.join(root, '.claude', '.rem-state.json'),
    JSON.stringify({ hook: { stopCount: 4 }, reviewGate: { wave: 1, mode: 'once' } }, null, 2)
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Rewrite one finding's Status line in the backlog file (simulates a fix agent's edit).
function markFixedInBacklog(id) {
  const content = fs.readFileSync(srFile, 'utf8');
  const blocks = content.split(/\n(?=###\s+\[SR-)/);
  const updated = blocks
    .map((b) => (b.includes(`[${id}]`) ? b.replace(/\*\*Status:\*\*\s*\w+/, '**Status:** fixed') : b))
    .join('\n');
  fs.writeFileSync(srFile, updated, 'utf8');
}

test('full round: seed → prioritize → fix → persist → empty rounds → clean convergence', () => {
  // --- Round 1: ingest ---
  let state = loadState(root);
  assert.equal(state.round, 0); // fresh state despite pre-seeded foreign keys
  state = { ...state, until: 'clean', minSeverity: 'MEDIUM' };

  const seeded = seedFromSharpReview(root, DATE);
  assert.equal(seeded.length, 3); // 004 is fixed, skipped
  assert.deepEqual(
    seeded.map((f) => f.id).sort(),
    ['SR-20260703-001', 'SR-20260703-002', 'SR-20260703-003']
  );
  assert.ok(seeded.every((f) => f.status === 'open' && f.unfixedRounds === 0));

  // prioritize respects minSeverity and orders by severity descending
  const targets = prioritize(seeded, state.minSeverity);
  assert.deepEqual(targets.map((f) => f.id), ['SR-20260703-001', 'SR-20260703-002']);

  // --- Simulate fix agents: HIGH fixed in the memory file, MEDIUM not ---
  markFixedInBacklog('SR-20260703-001');
  assert.equal(seedFromSharpReview(root, DATE).length, 2); // backlog reflects the fix

  recordRound(state, { findings: targets, fixed: ['SR-20260703-001'] }, 1000);
  assert.equal(state.round, 1);
  assert.equal(state.lastRoundAt, 1000);
  assert.equal(state.emptyRounds, 0); // MEDIUM 002 still open → not an empty round
  assert.equal(state.findings.find((f) => f.id === 'SR-20260703-001').status, 'fixed');
  assert.equal(state.findings.find((f) => f.id === 'SR-20260703-002').unfixedRounds, 1);

  const rc = checkRoundComplete(state);
  assert.equal(rc.complete, false);
  assert.deepEqual(rc.openFindings.map((f) => f.id), ['SR-20260703-002']);

  assert.equal(checkTermination(state).stop, false);

  // --- Persist and verify foreign keys survive ---
  assert.equal(saveState(root, state).persisted, true);
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.rem-state.json'), 'utf8'));
  assert.equal(raw.evolveState.round, 1);
  assert.equal(raw.hook.stopCount, 4);            // rem slice untouched
  assert.deepEqual(raw.reviewGate, { wave: 1, mode: 'once' }); // sharp-review slice untouched

  // --- Round 2: fix the remaining MEDIUM; round surfaces nothing new blocking ---
  markFixedInBacklog('SR-20260703-002');
  state = loadState(root); // reload roundtrip
  assert.equal(state.round, 1);
  assert.equal(state.until, 'clean');

  recordRound(state, { findings: [], fixed: ['SR-20260703-002'] }, 2000);
  assert.equal(state.emptyRounds, 1); // no new blocking finding → empty round
  assert.equal(checkRoundComplete(state).complete, true);
  assert.equal(checkTermination(state).stop, false); // clean needs 2 consecutive empty rounds

  // --- Round 3: another empty round → clean-converged ---
  recordRound(state, { findings: [] }, 3000);
  assert.equal(state.emptyRounds, 2);
  assert.deepEqual(checkTermination(state), { stop: true, reason: 'clean-converged' });

  // --- Persisted terminal state is what the CLI sees ---
  saveState(root, state);
  const out = JSON.parse(
    execFileSync(process.execPath, [EVOLVE_MJS, 'terminate', '--root', root], { encoding: 'utf8' })
  );
  assert.deepEqual(out, { stop: true, reason: 'clean-converged' });
});

test('CLI seed + prioritize read the same backlog and state', () => {
  const run = (args) =>
    JSON.parse(execFileSync(process.execPath, [EVOLVE_MJS, ...args, '--root', root], { encoding: 'utf8' }));

  const seeded = run(['seed', DATE]);
  assert.equal(seeded.length, 3);

  // Persist seeded findings, then prioritize via CLI with minSeverity HIGH.
  const state = { ...initState({ until: 'clean' }), findings: seeded };
  saveState(root, state);
  const high = run(['prioritize', 'HIGH']);
  assert.deepEqual(high.map((f) => f.id), ['SR-20260703-001']);
});

test('resolved mode: zero open findings after fixes terminates', () => {
  const state = initState({ until: 'resolved' });
  const seeded = seedFromSharpReview(root, DATE);
  recordRound(state, { findings: seeded }, 1);
  assert.equal(checkTermination(state).stop, false);

  recordRound(state, { findings: [], fixed: seeded.map((f) => f.id) }, 2);
  assert.deepEqual(checkTermination(state), { stop: true, reason: 'all-resolved' });
});
