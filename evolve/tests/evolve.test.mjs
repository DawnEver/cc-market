import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initState,
  loadState,
  saveState,
  recordRound,
  groupFindings,
  prioritize,
  checkTermination,
  confirmedByQuorum,
  seedFromSharpReview,
  writeRoundLog,
} from '../scripts/evolve.mjs';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-test-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}

test('initState defaults', () => {
  const s = initState();
  assert.equal(s.round, 0);
  assert.equal(s.until, 'ask');
  assert.equal(s.maxRounds, 10);
  assert.equal(s.maxAgents, 8);
  assert.equal(s.minSeverity, 'LOW');
  assert.equal(s.path, null);
  assert.equal(s.dryRun, false);
  assert.equal(s.commitMode, 'round');
  assert.equal(s.lastRoundAt, null);
  assert.equal(s.emptyRounds, 0);
  assert.deepEqual(s.findings, []);
});

test('groupFindings produces disjoint sets and merges overlapping files', () => {
  const findings = [
    { id: 'a', file: 'x.js' },
    { id: 'b', file: 'y.js', files: ['x.js'] }, // shares x.js with a
    { id: 'c', file: 'z.js' }, // isolated
    { id: 'd', file: 'w.js', files: ['z.js'] }, // shares z.js with c
  ];
  const groups = groupFindings(findings);
  assert.equal(groups.length, 2);

  // disjoint file-sets across groups
  const fileSets = groups.map((g) => {
    const s = new Set();
    for (const f of g) {
      if (f.file) s.add(f.file);
      for (const x of f.files || []) s.add(x);
    }
    return s;
  });
  for (let i = 0; i < fileSets.length; i++) {
    for (let j = i + 1; j < fileSets.length; j++) {
      for (const f of fileSets[i]) assert.ok(!fileSets[j].has(f), `overlap ${f}`);
    }
  }

  const ids = groups.map((g) => g.map((f) => f.id).sort().join(','));
  assert.ok(ids.includes('a,b'));
  assert.ok(ids.includes('c,d'));
});

test('groupFindings is order-independent', () => {
  const f1 = [{ id: 'a', file: 'x' }, { id: 'b', file: 'x' }, { id: 'c', file: 'y' }];
  const f2 = [{ id: 'c', file: 'y' }, { id: 'b', file: 'x' }, { id: 'a', file: 'x' }];
  const sig = (gs) => gs.map((g) => g.map((f) => f.id).sort().join(',')).sort().join('|');
  assert.equal(sig(groupFindings(f1)), sig(groupFindings(f2)));
});

test('prioritize filters and sorts by severity', () => {
  const findings = [
    { id: 1, severity: 'LOW' },
    { id: 2, severity: 'HIGH' },
    { id: 3, severity: 'INFO' },
    { id: 4, severity: 'MEDIUM' },
  ];
  const r = prioritize(findings, 'MEDIUM');
  assert.deepEqual(r.map((f) => f.severity), ['HIGH', 'MEDIUM']);

  const all = prioritize(findings, 'INFO');
  assert.deepEqual(all.map((f) => f.severity), ['HIGH', 'MEDIUM', 'LOW', 'INFO']);
});

test('checkTermination ask never auto-stops', () => {
  const s = initState({ until: 'ask' });
  s.emptyRounds = 5;
  assert.deepEqual(checkTermination(s), { stop: false, reason: 'ask' });
});

test('checkTermination clean: LOW-only round counts empty, HIGH resets', () => {
  const s = initState({ until: 'clean' });
  // round 1: LOW only -> empty (resolve it so it doesn't accumulate unfixedRounds)
  recordRound(s, { findings: [{ id: 1, severity: 'LOW' }], fixed: [1] }, 1);
  assert.equal(s.emptyRounds, 1);
  assert.equal(checkTermination(s).stop, false);
  // round 2: new OPEN HIGH -> resets emptyRounds
  recordRound(s, { findings: [{ id: 2, severity: 'HIGH' }] }, 2);
  assert.equal(s.emptyRounds, 0);
  assert.equal(checkTermination(s).stop, false);
  // resolve it in round 3 so it stops accumulating unfixedRounds
  // round 3+4: INFO/LOW only (and resolve the open HIGH) -> two empty rounds -> stop
  recordRound(s, { findings: [{ id: 3, severity: 'INFO' }], fixed: [2, 3] }, 3);
  recordRound(s, { findings: [{ id: 4, severity: 'LOW' }], fixed: [4] }, 4);
  const t = checkTermination(s);
  assert.equal(t.stop, true);
  assert.equal(t.reason, 'clean-converged');
});

test('checkTermination resolved: stops when all fixed/wont-fix and no new open', () => {
  const s = initState({ until: 'resolved' });
  recordRound(s, { findings: [{ id: 1, severity: 'HIGH' }, { id: 2, severity: 'LOW' }] }, 1);
  assert.equal(checkTermination(s).stop, false);
  // resolve both, no new findings
  recordRound(s, { findings: [], fixed: [1], wontFix: [2] }, 2);
  const t = checkTermination(s);
  assert.equal(t.stop, true);
  assert.equal(t.reason, 'all-resolved');
});

test('checkTermination resolved: empty findings stops immediately', () => {
  const s = initState({ until: 'resolved' });
  recordRound(s, { findings: [] }, 1);
  assert.equal(checkTermination(s).stop, true);
});

test('checkTermination max-rounds cap', () => {
  const s = initState({ until: 'clean', maxRounds: 2 });
  s.round = 2;
  const t = checkTermination(s);
  assert.equal(t.stop, true);
  assert.equal(t.reason, 'max-rounds');
});

test('checkTermination stuck-finding cap', () => {
  const s = initState({ until: 'ask' });
  s.findings = [{ id: 1, status: 'open', unfixedRounds: 3 }];
  const t = checkTermination(s);
  assert.equal(t.stop, true);
  assert.equal(t.reason, 'stuck-finding');
});

test('recordRound does not call Date.now (deterministic)', () => {
  const s = initState();
  recordRound(s, { findings: [] }, 12345);
  assert.equal(s.lastRoundAt, 12345);
  const s2 = initState();
  recordRound(s2, { findings: [] });
  assert.equal(s2.lastRoundAt, 0);
});

test('confirmedByQuorum drops single-reviewer, keeps 2+', () => {
  const raw = [
    { id: 1, file: 'a.js', summary: 'Null deref here', reviewer: 'r1' },
    { id: 2, file: 'a.js', summary: 'null   deref HERE', reviewer: 'r2' }, // same after normalize
    { id: 3, file: 'b.js', summary: 'Unused var', reviewer: 'r1' }, // single reviewer
  ];
  const out = confirmedByQuorum(raw, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'a.js');
});

test('confirmedByQuorum same reviewer twice does not count as quorum', () => {
  const raw = [
    { id: 1, file: 'a.js', summary: 'bug', reviewer: 'r1' },
    { id: 2, file: 'a.js', summary: 'bug', reviewer: 'r1' },
  ];
  assert.equal(confirmedByQuorum(raw, 2).length, 0);
});

test('saveState preserves foreign keys (rem/sharp-review slice) via shared deepMerge', () => {
  const root = tmpProject();
  const stateFile = path.join(root, '.claude', '.rem-state.json');
  // Simulate a file owned by other plugins (hook + reviewGate) with no evolveState yet.
  fs.writeFileSync(stateFile, JSON.stringify({
    hook: { taskActiveUntil: 999 },
    reviewGate: { wave: 2, memory: ['x'] },
  }, null, 2));

  const st = initState({ until: 'clean' });
  st.round = 3;
  const res = saveState(root, st);
  assert.equal(res.persisted, true);

  const written = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(written.evolveState.round, 3);
  assert.equal(written.reviewGate.wave, 2);          // foreign key preserved
  assert.deepEqual(written.reviewGate.memory, ['x']); // foreign key preserved
  assert.equal(written.hook.taskActiveUntil, 999);    // hook slice preserved

  const reloaded = loadState(root);
  assert.equal(reloaded.round, 3);
  assert.equal(reloaded.until, 'clean');
});

test('saveState creates the state file when absent (hard rem dependency)', () => {
  const root = tmpProject(); // no .rem-state.json yet
  const st = initState();
  st.round = 2;
  const res = saveState(root, st);
  assert.equal(res.persisted, true);
  // file is created and reloads the persisted state
  assert.ok(fs.existsSync(path.join(root, '.claude', '.rem-state.json')));
  assert.equal(loadState(root).round, 2);
});

test('seedFromSharpReview pulls OPEN findings, skips fixed', () => {
  const root = tmpProject();
  const day = path.join(root, '.claude', 'memory', '2026', '06', '15');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'sharp-review.md'), `---
name: sharp-review-2026-06-15
---

### [SR-20260615-001] [HIGH] src/a.js — Null deref on user
- **Status:** OPEN

### [SR-20260615-002] [LOW] src/b.js — Typo in log
- **Status:** FIXED
`);
  const seeded = seedFromSharpReview(root, '2026-06-15');
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].id, 'SR-20260615-001');
  assert.equal(seeded[0].severity, 'HIGH');
  assert.equal(seeded[0].status, 'open');
});

test('seedFromSharpReview returns [] when no backlog file', () => {
  assert.deepEqual(seedFromSharpReview(tmpProject(), '2026-06-15'), []);
});

test('writeRoundLog writes a rem-frontmatter memory entry', () => {
  const root = tmpProject();
  const file = writeRoundLog(root, { date: '2026-06-15', rounds: 2, fixed: 5, wontFix: 1 });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(file, /[\\/]2026[\\/]06[\\/]15[\\/]evolve-round-log\.md$/);
  assert.match(content, /metadata:\s*\n\s*type: project/);
  assert.match(content, /2 round\(s\): 5 fixed, 1 won't-fix/);
});
