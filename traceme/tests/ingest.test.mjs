import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, insertSession } from '../scripts/db.mjs';
import { ingestTranscript } from '../scripts/ingest.mjs';

const TEST_DB = join(tmpdir(), `traceme-ingest-${randomUUID()}.db`);

function makeSampleTranscript(sessionId) {
  return [
    JSON.stringify({ type: 'system', subtype: 'informational', sessionId }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Write a hello world function' }, uuid: 'u1', sessionId, isMeta: false, timestamp: '2026-06-09T10:00:00Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg-001', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: "Here's the code:" }], usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } }, uuid: 'a1', sessionId, timestamp: '2026-06-09T10:00:05Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the bug' }, uuid: 'u2', sessionId, isMeta: false, timestamp: '2026-06-09T10:05:00Z' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg-002', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'Fixed.' }], usage: { input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } }, uuid: 'a2', sessionId, timestamp: '2026-06-09T10:05:10Z' }),
  ].join('\n');
}

describe('Transcript Ingest', () => {
  const sessionId = 'test-session-ingest';

  before(() => {
    process.env.TRACEME_DB_PATH = TEST_DB;
    openDb();
  });
  after(() => {
    closeDb();
    delete process.env.TRACEME_DB_PATH;
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('should ingest a transcript and populate session totals', () => {
    insertSession({ id: sessionId, project: 'my-project', project_path: '/home/user/my-project', branch: 'feat/x', started_at: '2026-06-09T10:00:00Z' });

    const transcriptPath = join(tmpdir(), `traceme-test-${randomUUID()}.jsonl`);
    writeFileSync(transcriptPath, makeSampleTranscript(sessionId));
    const result = ingestTranscript(transcriptPath, sessionId);
    try { unlinkSync(transcriptPath); } catch {}

    assert.ok(result.promptCount >= 1);
    assert.ok(result.apiRequests >= 1);
    assert.ok(result.totalCost > 0);

    const db = openDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    assert.equal(session.project, 'my-project');
    assert.ok(session.total_tokens > 0);
    assert.ok(session.total_cost > 0);

    const summary = db.prepare('SELECT * FROM daily_summary WHERE date=? AND project=?').all('2026-06-09', 'my-project');
    assert.equal(summary.length, 1);
  });
});
