import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  openDb, closeDb,
  insertSession, closeSession,
  insertPrompt, batchUpdatePromptTokens,
  insertToolCall,
  upsertDailySummary,
  queryDailySummary, queryTopPrompts, queryToolUsage, querySessionStats
} from '../scripts/db.mjs';

const TEST_DB = join(tmpdir(), `traceme-test-${randomUUID()}.db`);

describe('DB Layer', { concurrency: 1 }, () => {
  before(() => openDb({ path: TEST_DB }));
  after(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('should insert and query a session', () => {
    insertSession({
      id: 'sess-001',
      project: 'test-project',
      project_path: '/home/user/test-project',
      branch: 'main',
      started_at: '2026-06-09T10:00:00Z'
    });
    closeSession('sess-001', '2026-06-09T11:00:00Z');
  });

  it('should insert and update prompts', () => {
    insertPrompt({ id: 'sess-001_0', session_id: 'sess-001', turn_index: 0, text: 'Write a function', timestamp: '2026-06-09T10:01:00Z' });
    insertPrompt({ id: 'sess-001_1', session_id: 'sess-001', turn_index: 1, text: 'Fix the bug', timestamp: '2026-06-09T10:30:00Z' });
    batchUpdatePromptTokens([
      { id: 'sess-001_0', input_tokens: 500, output_tokens: 300, cache_tokens: 100, cost_usd: 0.05, model: 'claude-sonnet-4', duration_ms: 2500 },
      { id: 'sess-001_1', input_tokens: 800, output_tokens: 400, cache_tokens: 200, cost_usd: 0.08, model: 'claude-sonnet-4', duration_ms: 3200 }
    ]);
  });

  it('should insert tool calls', () => {
    insertToolCall({ id: 'toolu_001', session_id: 'sess-001', prompt_id: 'sess-001_0', tool_name: 'Edit', summary: 'Write function to file', timestamp: '2026-06-09T10:02:00Z' });
    insertToolCall({ id: 'toolu_002', session_id: 'sess-001', prompt_id: 'sess-001_0', tool_name: 'Bash', summary: 'npm test', timestamp: '2026-06-09T10:03:00Z' });
    insertToolCall({ id: 'toolu_003', session_id: 'sess-001', prompt_id: 'sess-001_1', tool_name: 'Read', summary: 'read src/bug.js', timestamp: '2026-06-09T10:31:00Z' });
  });

  it('should upsert daily summary', () => {
    upsertDailySummary('2026-06-09', 'test-project', { session_count: 1, prompt_count: 2, total_tokens: 2300, total_cost: 0.13, top_model: 'claude-sonnet-4' });
  });

  it('should query daily summary', () => {
    const rows = queryDailySummary('2026-06-09');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, 'test-project');
    assert.equal(rows[0].total_cost, 0.13);
  });

  it('should query top prompts', () => {
    const rows = queryTopPrompts('2026-06-09', 5);
    assert.equal(rows.length, 2);
  });

  it('should query tool usage', () => {
    const rows = queryToolUsage('2026-06-09');
    assert.equal(rows.length, 3);
  });

  it('should query session stats', () => {
    openDb({ path: TEST_DB }).prepare('UPDATE sessions SET total_tokens=2300, total_cost=0.13 WHERE id=?').run('sess-001');
    const rows = querySessionStats('2026-06-09');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, 'test-project');
  });
});
