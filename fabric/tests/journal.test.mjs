// Tests for engine/journal.mjs — the append-only session journal (G4). The registry is
// in-process; a restart forgets every handle. The journal is the FACT trail that lets the
// layer above reconcile (kill-or-adopt) instead of leaking zombies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

test('recordEvent appends jsonl; readJournal parses it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, readJournal, journalPath } = await import('../engine/journal.mjs?t=1');
  recordEvent({ event: 'spawn', id: 's1', pid: 11, provider: 'deepseek', node: null });
  recordEvent({ event: 'close', id: 's1' });
  assert.ok(existsSync(journalPath()));
  const rows = readJournal();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'spawn');
  assert.equal(rows[0].pid, 11);
  assert.ok(typeof rows[0].ts === 'number');
});

test('reconcile names sessions with a spawn but no close/loss, with pid liveness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj2-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, reconcile } = await import('../engine/journal.mjs?t=2');
  recordEvent({ event: 'spawn', id: 'a', pid: 100, provider: 'deepseek' });
  recordEvent({ event: 'spawn', id: 'b', pid: 200, provider: 'claude' });
  recordEvent({ event: 'close', id: 'a' });
  const orphans = reconcile({ _pidAlive: (pid) => pid === 200 });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'b');
  assert.equal(orphans[0].pidAlive, true);
});

test('registry writes spawn/close events to the journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj3-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { journalPath } = await import('../engine/journal.mjs?t=3');
  const { createSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({ id: 'n1', pid: 77, send: async () => ({ text: 'x', turn: 1 }), close: async () => 0 });
  const desc = await createSession({ provider: 'deepseek' }, fakeOpen);
  await closeSession(desc.id);
  const lines = readFileSync(journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const events = lines.map((l) => l.event);
  assert.ok(events.includes('spawn'), `journal must record spawn, got: ${events}`);
  assert.ok(events.includes('close'), `journal must record close, got: ${events}`);
  assert.equal(lines.find((l) => l.event === 'spawn').pid, 77);
});

// SR-003: a REMOTE session's pid belongs to the peer's process table — reconcile must
// not consult the local one (PID reuse makes pidAlive:true an invitation to kill an
// unrelated local process).
test('reconcile never pid-checks remote sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj4-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, reconcile } = await import('../engine/journal.mjs?t=4');
  recordEvent({ event: 'spawn', id: 'r1', pid: 300, provider: 'deepseek', node: 'WS2' });
  const orphans = reconcile({ _pidAlive: () => { throw new Error('must not be called for remote'); } });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pidAlive, null, 'remote liveness is unknown here, never claimed');
});

// SR-016: a close that THROWS must not be journaled as a close — the child may live on.
test('a failed close journals close_failed and stays open in reconcile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj5-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { readJournal, reconcile } = await import('../engine/journal.mjs?t=5');
  const { createSession, closeSession, _resetRegistry } = await import('../engine/session.mjs');
  _resetRegistry();
  const fakeOpen = async () => ({ id: 'n1', pid: 88, send: async () => ({ text: 'x', turn: 1 }), close: async () => { throw new Error('close hung'); } });
  const desc = await createSession({ provider: 'deepseek' }, fakeOpen);
  await assert.rejects(closeSession(desc.id), /close hung/);
  const events = readJournal().map((r) => r.event);
  assert.ok(events.includes('close_failed'), `got: ${events}`);
  assert.ok(!events.includes('close'), 'must not record a successful close');
  assert.equal(reconcile({ _pidAlive: () => true }).length, 1, 'still an orphan candidate');
});

// ── SR-044 / SR-028: one file per WRITER. Concurrent appends from several fabric
// processes to a single file have no line-integrity guarantee on Windows, and a torn
// line is exactly the spawn record reconcile needs. Each process owns its own file;
// the read side merges.
test('the journal file is per-process and readJournal merges every journal file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj6-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, readJournal, journalPath } = await import('../engine/journal.mjs?t=6');
  recordEvent({ event: 'spawn', id: 'mine', pid: 1 });
  assert.equal(basename(journalPath()), `journal-${process.pid}.jsonl`);

  // Another process's file, and the legacy single-file name, must both be merged.
  writeFileSync(join(dir, 'journal-999999.jsonl'), `${JSON.stringify({ ts: 1, event: 'spawn', id: 'theirs', pid: 2 })}\n`);
  writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ ts: 2, event: 'spawn', id: 'legacy', pid: 3 })}\n`);

  const ids = readJournal().map((r) => r.id);
  assert.deepEqual(ids, ['theirs', 'legacy', 'mine'], 'merged and sorted by ts');
});

// SR-007 / SR-021, read side: a torn line is COUNTED, never silently erased — reconcile
// must be able to say "the list may be incomplete".
test('readJournal counts corrupt lines and reconcile reports them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj7-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, readJournal, reconcile } = await import('../engine/journal.mjs?t=7');
  recordEvent({ event: 'spawn', id: 'ok', pid: 5 });
  appendFileSync(join(dir, 'journal-888888.jsonl'), '{"ts":1,"event":"spa\n{"ts":2,"event":"clo\n');

  assert.equal(readJournal().length, 1, 'the plain return stays a plain array of events');
  const { events, corruptLines } = readJournal({ withStats: true });
  assert.equal(events.length, 1);
  assert.equal(corruptLines, 2);
  assert.equal(reconcile({ _pidAlive: () => true }).corruptLines, 2);
});

// SR-007 / SR-021, write side: a swallowed append leaves a live child with NO record.
// It must be loud (once) and counted.
test('a failing append warns once on stderr and increments the failure counter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj8-'));
  const notADir = join(dir, 'blocked');
  writeFileSync(notADir, 'I am a file, not a journal directory');
  process.env.FABRIC_JOURNAL_DIR = notADir;
  const { recordEvent, journalWriteFailures } = await import('../engine/journal.mjs?t=8');

  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try {
    recordEvent({ event: 'spawn', id: 'x', pid: 1 });
    recordEvent({ event: 'spawn', id: 'y', pid: 2 });
  } finally { process.stderr.write = real; }

  assert.equal(journalWriteFailures(), 2, 'every failure counts');
  const warnings = written.filter((s) => /fabric journal: writes failing/.test(s));
  assert.equal(warnings.length, 1, 'but the warning is emitted once per process, not spammed');
});

// SR-006 / SR-028: the bound. Per-process files are bounded by process life; the FLEET's
// history is bounded by compaction — a spawn that has a matching close/loss is a settled
// fact nobody needs to replay.
test('compactJournal drops settled sessions and folds other processes files into one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj9-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  const { recordEvent, readJournal, reconcile, compactJournal, journalPath } = await import('../engine/journal.mjs?t=9');
  writeFileSync(join(dir, 'journal-777777.jsonl'), [
    JSON.stringify({ ts: 1, event: 'spawn', id: 'settled', pid: 2 }),
    JSON.stringify({ ts: 2, event: 'close', id: 'settled' }),
    JSON.stringify({ ts: 3, event: 'spawn', id: 'orphan', pid: 3 }),
    JSON.stringify({ ts: 4, event: 'spawn', id: 'hung', pid: 4 }),
    JSON.stringify({ ts: 5, event: 'close_failed', id: 'hung' }),
  ].join('\n') + '\n');
  recordEvent({ event: 'spawn', id: 'live', pid: 6 });

  const res = compactJournal();
  assert.equal(res.dropped, 2, 'the settled spawn and its close');

  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [basename(journalPath()), 'journal-compact.jsonl'].sort(),
    'other processes files are folded away; this process live file is never deleted');

  const ids = readJournal().map((r) => r.id);
  assert.ok(!ids.includes('settled'), 'a settled session is gone');
  assert.deepEqual([...new Set(ids)].sort(), ['hung', 'live', 'orphan']);
  assert.deepEqual(reconcile({ _pidAlive: () => true }).map((o) => o.id).sort(), ['hung', 'live', 'orphan']);
});

// 2026-08-10: the hot path is bounded too — the live file ROTATES past a size threshold
// (renamed away, fresh file starts), and no event is lost across the rotation.
test('recordEvent rotates the live file past the size bound without losing events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fj-rot-'));
  process.env.FABRIC_JOURNAL_DIR = dir;
  process.env.FABRIC_JOURNAL_MAX_BYTES = '200'; // tiny threshold for the test
  const { recordEvent, readJournal } = await import('../engine/journal.mjs?t=rot');

  for (let i = 0; i < 12; i++) recordEvent({ event: 'spawn', id: `r${i}`, pid: i });

  const files = readdirSync(dir).sort();
  const rotated = files.filter((f) => /rot-1\.jsonl$/.test(f));
  assert.equal(rotated.length, 1, 'the oversized live file was rotated away once');
  assert.ok(readFileSync(join(dir, rotated[0]), 'utf8').length >= 200, 'the rotated chunk carries the overflow');

  const ids = readJournal().map((r) => r.id);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `r${i}`), 'no event lost across the rotation');

  delete process.env.FABRIC_JOURNAL_MAX_BYTES;
});
