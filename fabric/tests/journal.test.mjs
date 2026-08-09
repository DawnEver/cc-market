// Tests for engine/journal.mjs — the append-only session journal (G4). The registry is
// in-process; a restart forgets every handle. The journal is the FACT trail that lets the
// layer above reconcile (kill-or-adopt) instead of leaking zombies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
